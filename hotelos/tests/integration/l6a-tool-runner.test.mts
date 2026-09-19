/**
 * Tanda L6a · lote 4 · integración (Postgres): tool runner del API con HITL
 * sobre el servicio (runAiTool / confirmToolCall) + Prisma, porque la ruta
 * POST /ai/tool-calls/:id/confirm la añade el orquestador. Dos organizaciones
 * AISLADAS (helpers/l2-tenant.mts); Faranda y org_123 solo se leen.
 *
 *   · createWorkOrder (escritura low) → fila awaiting_confirmation + audit
 *     AI_TOOL_CONFIRMATION_REQUESTED (sin revisión humana: solo high/critical o
 *     política la exigen); approve (recepción con maintenance.workorder.create +
 *     ai.tool.execute) → work_orders +1, fila succeeded con confirmedBy;
 *   · blockRoomForMaintenance (escritura high) → awaiting + ai_human_review_items
 *     pending; reject → fila rejected y revisión rejected;
 *   · usuario de la organización B → 404 opaco;
 *   · propiedad con aiEnabled=false → fila rejected ai_disabled_for_property;
 *   · presupuesto: configurationJson.monthlyBudgetEur 0,01 + fila previa cost_eur
 *     0,02 → ForbiddenError details.code AI_BUDGET_EXCEEDED;
 *   · rate limit (AI_RATE_LIMIT_PER_MINUTE=1, fetch simulado con usage) →
 *     analyzeReviewSentiment dos veces → segunda TooManyRequestsError 429;
 *   · PII: el cuerpo enviado al proveedor lleva [NOMBRE_1] y [TEL_1], nunca los
 *     valores; la fila queda succeeded (borrador = lectura) con coste real > 0;
 *   · scanIdDocumentCommand con visión simulada → fields y fila completed con modelo.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/l6a-tool-runner.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const { createIsolatedTenant, cleanupTenant, enableModules, newRunId, farandaInvariants } = await import("./helpers/l2-tenant.mts");
type IsolatedTenant = import("./helpers/l2-tenant.mts").IsolatedTenant;
const { prisma } = await import("@hotelos/database");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { runAiTool, confirmToolCall } = await import("../../apps/api/src/modules/ai-operations/tool-runner.service.js");
const { scanIdDocumentCommand } = await import("../../apps/api/src/modules/ai/scan-id-document.command.js");
const { resetAiCoreForTests } = await import("../../apps/api/src/lib/ai-client.js");
const { runEvaluation } = await import("../../apps/api/src/modules/ai-operations/governance.service.js");
const { assertEntityAccess } = await import("../../apps/api/src/lib/tenancy.js");
const { ForbiddenError, NotFoundError, TooManyRequestsError } = await import("../../apps/api/src/lib/http-error.js");
type UserContext = import("../../apps/api/src/lib/demo-store.js").UserContext;
type PermissionKey = import("@hotelos/shared").PermissionKey;

const RUN = `l6a${newRunId()}`;
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const CONFIGURED_ENV = { AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: "sk-ant-l6a-test", AI_USD_EUR_RATE: "0.9" } as const;

const PROPOSER_PERMISSIONS: PermissionKey[] = ["ai.tool.execute", "ai.high_risk.confirm", "maintenance.workorder.create", "maintenance.workorder.manage", "reputation.read", "reputation.respond", "guest_register.create", "pms.reservation.read"];
const RECEPTION_CONFIRM_PERMISSIONS: PermissionKey[] = ["ai.tool.execute", "maintenance.workorder.create"];

type Captured = { url: string; body: Record<string, unknown> };

function fakeFetch(captured: Captured[], responder: (body: Record<string, unknown>) => unknown): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    captured.push({ url: String(input), body });
    return new Response(JSON.stringify(responder(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function anthropicText(text: string, model: string, usage = { input_tokens: 100, output_tokens: 50 }) {
  return { id: "msg_l6a", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", usage };
}

const DOC_KEYS = ["documentType", "documentNumber", "documentSupportNumber", "firstName", "surname1", "surname2", "dateOfBirth", "nationality", "sex"] as const;
function identityJson(fields: Partial<Record<(typeof DOC_KEYS)[number], string>>): string {
  const data: Record<string, unknown> = {};
  const confidence: Record<string, number | null> = {};
  for (const key of DOC_KEYS) {
    data[key] = fields[key] ?? null;
    confidence[key] = fields[key] ? 0.95 : null;
  }
  data.confidence = confidence;
  return JSON.stringify(data);
}

let A: IsolatedTenant;
let B: IsolatedTenant;
let proposer: UserContext;
let receptionConfirm: UserContext;
let userB: UserContext;
let invariantsBefore: Awaited<ReturnType<typeof farandaInvariants>>;
let workOrdersBefore = 0;
let createWorkOrderCallId = "";

function context(tenant: IsolatedTenant, propertyId: string, userId: string, permissions: PermissionKey[]): UserContext {
  return { organizationId: tenant.organizationId, propertyId, userId, fullName: `L6a ${RUN}`, deviceId: `dev_${RUN}`, permissions };
}

async function auditsFor(entityId: string): Promise<Array<{ action: string; actorType: string }>> {
  await flushAuditQueues();
  return prisma.auditEvent.findMany({ where: { organizationId: A.organizationId, entityType: "ai_tool_call", entityId }, select: { action: true, actorType: true }, orderBy: { createdAt: "asc" } });
}

before(async () => {
  invariantsBefore = await farandaInvariants();
  A = await createIsolatedTenant(RUN);
  B = await createIsolatedTenant(`${RUN}b`);
  // reputation_quality no está en DEFAULT_ENABLED_MODULE_CODES (maintenance, pms_core y
  // spain_guest_register_compliance sí): sin activarlo el runner denegaría por módulo.
  await enableModules(A.propertyA, ["reputation_quality"]);
  proposer = context(A, A.propertyA, A.users.generalManager.id, PROPOSER_PERMISSIONS);
  receptionConfirm = context(A, A.propertyA, A.users.receptionist.id, RECEPTION_CONFIRM_PERMISSIONS);
  userB = context(B, B.propertyA, B.users.receptionist.id, PROPOSER_PERMISSIONS);
  workOrdersBefore = await prisma.workOrder.count({ where: { propertyId: A.propertyA } });
});

after(async () => {
  resetAiCoreForTests();
  try {
    await flushAuditQueues();
    if (A) await cleanupTenant(A.organizationId);
    if (B) await cleanupTenant(B.organizationId);
  } finally {
    assert.deepEqual(await farandaInvariants(), invariantsBefore, "las cifras de Faranda no cambian");
  }
  assert.equal(await prisma.organization.count({ where: { id: { in: [A.organizationId, B.organizationId] } } }), 0, "sin organizaciones residuales de esta suite");
});

describe("L6a-4 · tool runner con HITL sobre Prisma", () => {
  it("createWorkOrder (escritura) → awaiting_confirmation con tarjeta, fila en ai_tool_calls y audit AI_TOOL_CONFIRMATION_REQUESTED (actor ai); sin revisión humana para riesgo low", async () => {
    const result = await runAiTool({ context: proposer, toolName: "createWorkOrder", input: { title: `Grifo que gotea ${RUN}`, priority: "normal", blocksRoom: false }, correlationId: `corr_${RUN}_wo` });
    assert.equal(result.status, "awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") return;
    createWorkOrderCallId = result.toolCallId;
    assert.deepEqual(result.preview, { action: "createWorkOrder", title: `Grifo que gotea ${RUN}`, priority: "normal", blocksRoom: false });

    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: createWorkOrderCallId } });
    assert.equal(row.organizationId, A.organizationId);
    assert.equal(row.propertyId, A.propertyA);
    assert.equal(row.userId, proposer.userId);
    assert.equal(row.toolName, "createWorkOrder");
    assert.equal(row.status, "awaiting_confirmation");
    assert.equal(row.requiredConfirmation, true);
    assert.equal(row.automationLevel, "suggest_and_confirm");
    assert.equal(Number(row.costEur), 0, "sin llamada al modelo el coste es 0 real");
    assert.equal(await prisma.workOrder.count({ where: { propertyId: A.propertyA } }), workOrdersBefore, "nada se ejecuta antes de confirmar");
    assert.equal(await prisma.aiHumanReviewItem.count({ where: { relatedEntityType: "ai_tool_call", relatedEntityId: createWorkOrderCallId } }), 0, "riesgo low sin política: no se encola revisión");

    const audits = await auditsFor(createWorkOrderCallId);
    assert.deepEqual(audits, [{ action: "AI_TOOL_CONFIRMATION_REQUESTED", actorType: "ai" }]);
  });

  it("confirmToolCall approve (recepción con maintenance.workorder.create + ai.tool.execute) → work_orders +1, fila succeeded con confirmedBy y audit AI_TOOL_EXECUTED", async () => {
    const result = await confirmToolCall({ context: receptionConfirm, toolCallId: createWorkOrderCallId, decision: "approve", notes: "Confirmado en recepción", correlationId: `corr_${RUN}_wo_ok` });
    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    const order = result.output as { id: string; title: string; propertyId: string; status: string };
    assert.equal(order.title, `Grifo que gotea ${RUN}`);
    assert.equal(order.propertyId, A.propertyA);
    assert.equal(await prisma.workOrder.count({ where: { propertyId: A.propertyA } }), workOrdersBefore + 1);
    assert.ok(await prisma.workOrder.findUnique({ where: { id: order.id } }), "el parte existe en Prisma");

    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: createWorkOrderCallId } });
    assert.equal(row.status, "succeeded");
    assert.equal(row.confirmedBy, receptionConfirm.userId);
    assert.equal(row.errorMessage, null);
    const output = row.outputJson as { confirmation?: { decision?: string; decidedBy?: string }; execution?: { workOrderId?: string } };
    assert.equal(output.confirmation?.decision, "approve");
    assert.equal(output.confirmation?.decidedBy, receptionConfirm.userId);
    assert.equal(output.execution?.workOrderId, order.id, "outputJson guarda el resumen sin PII");

    const audits = await auditsFor(createWorkOrderCallId);
    assert.deepEqual(audits.map((event) => event.action), ["AI_TOOL_CONFIRMATION_REQUESTED", "AI_TOOL_CONFIRMATION_APPROVED", "AI_TOOL_EXECUTED"]);
    assert.deepEqual(audits.map((event) => event.actorType), ["ai", "user", "ai"]);

    await assert.rejects(confirmToolCall({ context: receptionConfirm, toolCallId: createWorkOrderCallId, decision: "approve", correlationId: `corr_${RUN}_replay` }), (error: unknown) => error instanceof NotFoundError, "una fila ya decidida no se distingue de una inexistente");
  });

  it("blockRoomForMaintenance (escritura high) → awaiting + revisión humana pending; reject → fila rejected y revisión rejected", async () => {
    const order = await prisma.workOrder.findFirstOrThrow({ where: { propertyId: A.propertyA, title: `Grifo que gotea ${RUN}` }, select: { id: true } });
    const result = await runAiTool({ context: proposer, toolName: "blockRoomForMaintenance", input: { workOrderId: order.id }, correlationId: `corr_${RUN}_block` });
    assert.equal(result.status, "awaiting_confirmation");
    if (result.status !== "awaiting_confirmation") return;
    const review = await prisma.aiHumanReviewItem.findFirst({ where: { relatedEntityType: "ai_tool_call", relatedEntityId: result.toolCallId } });
    assert.ok(review, "riesgo high → revisión humana encolada");
    assert.equal(review.status, "pending");
    assert.equal(review.organizationId, A.organizationId);
    assert.equal(review.propertyId, A.propertyA);

    const rejected = await confirmToolCall({ context: proposer, toolCallId: result.toolCallId, decision: "reject", notes: "La habitación está ocupada", correlationId: `corr_${RUN}_block_no` });
    assert.equal(rejected.status, "rejected");
    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: result.toolCallId } });
    assert.equal(row.status, "rejected");
    assert.equal(row.confirmedBy, proposer.userId);
    assert.match(String(row.errorMessage), /^Rechazada por el usuario: La habitación está ocupada/);
    assert.equal((await prisma.aiHumanReviewItem.findUniqueOrThrow({ where: { id: review.id } })).status, "rejected");
    assert.equal((await prisma.workOrder.findUniqueOrThrow({ where: { id: order.id } })).blocksRoom, false, "nada se ejecuta al rechazar");
    const audits = await auditsFor(result.toolCallId);
    assert.deepEqual(audits.map((event) => event.action), ["AI_TOOL_CONFIRMATION_REQUESTED", "AI_TOOL_CONFIRMATION_REJECTED"]);
  });

  it("usuario de la organización B sobre una llamada pendiente de A → 404 opaco (y la fila sigue pendiente)", async () => {
    const pending = await runAiTool({ context: proposer, toolName: "createWorkOrder", input: { title: `Bombilla fundida ${RUN}`, priority: "normal", blocksRoom: false }, correlationId: `corr_${RUN}_b` });
    assert.equal(pending.status, "awaiting_confirmation");
    if (pending.status !== "awaiting_confirmation") return;
    await assert.rejects(confirmToolCall({ context: userB, toolCallId: pending.toolCallId, decision: "approve", correlationId: `corr_${RUN}_b_confirm` }), (error: unknown) => {
      assert.ok(error instanceof NotFoundError);
      assert.equal(error.statusCode, 404);
      assert.equal(error.message, "Llamada de herramienta no encontrada.");
      return true;
    });
    assert.equal((await prisma.aiToolCall.findUniqueOrThrow({ where: { id: pending.toolCallId } })).status, "awaiting_confirmation");
    assert.equal(await prisma.workOrder.count({ where: { propertyId: A.propertyA } }), workOrdersBefore + 1);
  });

  it("propiedad con aiEnabled=false → denied ai_disabled_for_property y fila rejected con ese motivo", async () => {
    await prisma.propertyAiSetting.upsert({ where: { propertyId: A.propertyB }, create: { propertyId: A.propertyB, aiEnabled: false, voiceLocales: ["es-ES"] }, update: { aiEnabled: false } });
    const ctx = { ...proposer, propertyId: A.propertyB };
    const result = await runAiTool({ context: ctx, toolName: "findReservation", input: { code: `RES-${RUN}` }, correlationId: `corr_${RUN}_off` });
    assert.equal(result.status, "denied");
    if (result.status !== "denied") return;
    assert.equal(result.reason, "ai_disabled_for_property");
    assert.ok(result.toolCallId);
    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: result.toolCallId! } });
    assert.equal(row.status, "rejected");
    assert.equal(row.errorMessage, "ai_disabled_for_property");
    assert.equal(row.propertyId, A.propertyB);
    const audits = await auditsFor(row.id);
    assert.deepEqual(audits, [{ action: "AI_TOOL_DENIED", actorType: "ai" }]);
  });

  it("presupuesto: monthlyBudgetEur 0,01 en configurationJson + fila previa con cost_eur 0,02 → ForbiddenError 403 AI_BUDGET_EXCEEDED sin ejecutar", async () => {
    await prisma.propertyAiSetting.upsert({ where: { propertyId: A.propertyA }, create: { propertyId: A.propertyA, aiEnabled: true, voiceLocales: ["es-ES"], configurationJson: { monthlyBudgetEur: 0.01 } }, update: { configurationJson: { monthlyBudgetEur: 0.01 } } });
    const seed = await prisma.aiToolCall.create({ data: { organizationId: A.organizationId, propertyId: A.propertyA, toolName: `l6a_budget_seed_${RUN}`, status: "succeeded", inputJson: {}, model: "claude-sonnet-5", costEur: 0.02 } });
    try {
      let executed = 0;
      await assert.rejects(
        runAiTool({ context: proposer, toolName: "findReservation", input: { code: `RES-${RUN}` }, execute: async () => (executed += 1), correlationId: `corr_${RUN}_budget` }),
        (error: unknown) => {
          assert.ok(error instanceof ForbiddenError);
          assert.equal(error.statusCode, 403);
          const details = error.details as { code: string; budgetEur: number; spentEur: number; propertyId: string };
          assert.equal(details.code, "AI_BUDGET_EXCEEDED");
          assert.equal(details.budgetEur, 0.01);
          assert.equal(details.spentEur, 0.02);
          assert.equal(details.propertyId, A.propertyA);
          return true;
        }
      );
      assert.equal(executed, 0);
      const denied = await prisma.aiToolCall.findFirst({ where: { organizationId: A.organizationId, toolName: "findReservation", status: "rejected", errorMessage: "budget_exceeded" } });
      assert.ok(denied, "la denegación por presupuesto queda registrada");
    } finally {
      await prisma.aiToolCall.delete({ where: { id: seed.id } });
      await prisma.propertyAiSetting.update({ where: { propertyId: A.propertyA }, data: { configurationJson: {} } });
    }
  });

  it("rate limit: AI_RATE_LIMIT_PER_MINUTE=1 con fetch simulado → analyzeReviewSentiment responde con coste real y la segunda llamada es TooManyRequestsError 429", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({
      env: { ...CONFIGURED_ENV, AI_RATE_LIMIT_PER_MINUTE: "1" },
      fetchImpl: fakeFetch(captured, (body) => anthropicText(JSON.stringify({ categories: [{ code: "ruido", sentiment: -1, confidence: 0.9, snippet: "ruido de la calle" }], language: "es", summary: "Queja por el ruido nocturno." }), String(body.model)))
    });
    const first = await runAiTool({ context: proposer, toolName: "analyzeReviewSentiment", input: { text: "Mucho ruido de la calle por la noche, no pudimos dormir." }, correlationId: `corr_${RUN}_rl1` });
    assert.equal(first.status, "executed");
    if (first.status !== "executed") return;
    assert.equal(first.configured, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.body.model, "claude-haiku-4-5-20251001", "clasificación con el modelo barato");
    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: first.toolCallId } });
    assert.equal(row.status, "succeeded");
    assert.equal(row.model, "claude-haiku-4-5-20251001");
    assert.equal(row.tokensInput, 100);
    assert.equal(row.tokensOutput, 50);
    // haiku 4.5: 100 × 1 $/M + 50 × 5 $/M = 0,00035 $ → × 0,9 = 0,000315 €
    assert.equal(Number(row.costEur), 0.000315);

    await assert.rejects(runAiTool({ context: proposer, toolName: "analyzeReviewSentiment", input: { text: "Segunda reseña." }, correlationId: `corr_${RUN}_rl2` }), (error: unknown) => {
      assert.ok(error instanceof TooManyRequestsError);
      assert.equal(error.statusCode, 429);
      assert.match(error.message, /Límite de peticiones de IA alcanzado/);
      return true;
    });
    assert.equal(captured.length, 1, "el límite se aplica antes de la segunda petición");
    const failed = await prisma.aiToolCall.findFirst({ where: { organizationId: A.organizationId, toolName: "analyzeReviewSentiment", status: "failed" } });
    assert.ok(failed);
    assert.match(String(failed.errorMessage), /^rate_limited:/);
  });

  it("PII: el cuerpo enviado al proveedor lleva [NOMBRE_1] y [TEL_1] y nunca los valores; el borrador vuelve restaurado y la fila queda succeeded con coste > 0", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({
      env: CONFIGURED_ENV,
      fetchImpl: fakeFetch(captured, (body) => anthropicText("Gracias por su opinión, [NOMBRE_1]. Lamentamos las molestias por el ruido y le invitamos a escribirnos a recepción. Dirección del hotel.", String(body.model)))
    });
    const review = "La Sra. Ludmila Ferreiro (612 345 678) se quejó del ruido de la calle durante toda la noche.";
    const result = await runAiTool({ context: proposer, toolName: "draftReviewResponse", input: { reviewText: review, language: "es" }, correlationId: `corr_${RUN}_pii` });
    assert.equal(result.status, "executed");
    if (result.status !== "executed") return;
    assert.equal(result.configured, true);
    assert.equal(captured.length, 1);
    const sent = JSON.stringify(captured[0]!.body);
    assert.ok(sent.includes("NOMBRE_1"), "el nombre viaja como marcador");
    assert.ok(sent.includes("TEL_1"), "el teléfono viaja como marcador");
    assert.ok(!sent.includes("Ludmila") && !sent.includes("Ferreiro"), "el nombre nunca llega al proveedor");
    assert.ok(!sent.includes("612 345 678") && !sent.includes("612345678"), "el teléfono nunca llega al proveedor");
    const output = result.output as { draft: string };
    assert.match(output.draft, /Ludmila Ferreiro/, "el marcador se restaura en la respuesta");
    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: result.toolCallId } });
    assert.equal(row.status, "succeeded", "un borrador es lectura: se ejecuta sin confirmación previa");
    assert.equal(row.model, "claude-sonnet-5");
    assert.ok(Number(row.costEur) > 0, `coste real calculado desde usage: ${row.costEur}`);
    // sonnet-5: 100 × 2 $/M + 50 × 10 $/M = 0,0007 $ → × 0,9 = 0,00063 €
    assert.equal(Number(row.costEur), 0.00063);
  });

  it("scanIdDocumentCommand con visión simulada → fields y fila scan_id_document completed con modelo y coste", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({
      env: CONFIGURED_ENV,
      fetchImpl: fakeFetch(captured, (body) => anthropicText(identityJson({ documentType: "DNI", documentNumber: `${RUN.slice(-8).toUpperCase()}Z`, firstName: "Prueba", surname1: "Ensayo", dateOfBirth: "1990-01-01", nationality: "ESP", sex: "F" }), String(body.model), { input_tokens: 1500, output_tokens: 120 }))
    });
    const result = await scanIdDocumentCommand({ context: proposer, imageDataUrl: PNG, correlationId: `corr_${RUN}_scan` });
    assert.equal(result.configured, true);
    if (!result.configured) return;
    assert.equal(result.source, "ai");
    assert.equal(result.fields.documentType, "DNI");
    assert.equal(result.fields.firstName, "Prueba");
    assert.equal(captured.length, 1);
    assert.ok(JSON.stringify(captured[0]!.body).includes('"type":"image"'), "la imagen viaja íntegra como bloque image (política id-scan: sin redacción de bytes)");
    const row = await prisma.aiToolCall.findFirstOrThrow({ where: { organizationId: A.organizationId, toolName: "scan_id_document" }, orderBy: { createdAt: "desc" } });
    assert.equal(row.status, "completed");
    assert.equal(row.model, "claude-sonnet-5");
    assert.equal(row.tokensInput, 1500);
    assert.equal(row.tokensOutput, 120);
    // sonnet-5: 1500 × 2 $/M + 120 × 10 $/M = 0,0042 $ → × 0,9 = 0,00378 €
    assert.equal(Number(row.costEur), 0.00378);
    assert.deepEqual(row.inputJson, { hasImage: true });
    assert.ok(!JSON.stringify(row.outputJson).includes("Prueba"), "la fila no guarda los valores del documento");
  });

  // --- Corrección 1 (seguridad-pii-hitl / cliente-fallback-coste) sobre Prisma real ---------------

  it("corrección 1 · SEC-02: dos confirmaciones concurrentes de la misma fila → una succeeded y otra 404 opaco; work_orders +1 una sola vez y una sola auditoría de ejecución", async () => {
    const pending = await runAiTool({ context: proposer, toolName: "createWorkOrder", input: { title: `Persiana atascada ${RUN}`, priority: "normal", blocksRoom: false }, correlationId: `corr_${RUN}_race` });
    assert.equal(pending.status, "awaiting_confirmation");
    if (pending.status !== "awaiting_confirmation") return;
    const before = await prisma.workOrder.count({ where: { propertyId: A.propertyA } });
    const results = await Promise.allSettled([
      confirmToolCall({ context: receptionConfirm, toolCallId: pending.toolCallId, decision: "approve", correlationId: `corr_${RUN}_race_1` }),
      confirmToolCall({ context: receptionConfirm, toolCallId: pending.toolCallId, decision: "approve", correlationId: `corr_${RUN}_race_2` })
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof confirmToolCall>>> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    assert.equal(fulfilled.length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.equal(fulfilled[0]!.value.status, "succeeded");
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]!.reason instanceof NotFoundError, "la aprobación perdida recibe el 404 opaco");
    assert.equal(await prisma.workOrder.count({ where: { propertyId: A.propertyA } }), before + 1, "la escritura ocurre UNA vez");
    const row = await prisma.aiToolCall.findUniqueOrThrow({ where: { id: pending.toolCallId } });
    assert.equal(row.status, "succeeded");
    assert.equal(row.confirmedBy, receptionConfirm.userId);
    const audits = await auditsFor(pending.toolCallId);
    assert.deepEqual(audits.map((event) => event.action), ["AI_TOOL_CONFIRMATION_REQUESTED", "AI_TOOL_CONFIRMATION_APPROVED", "AI_TOOL_EXECUTED"]);
  });

  it("corrección 1 · SEC-03 / WT-08: la misma organización desde la propiedad B → 404 opaco (fila pendiente intacta); assertEntityAccess(aiToolCallConfirmation) solo resuelve filas pendientes sin reclamar", async () => {
    const pending = await runAiTool({ context: proposer, toolName: "createWorkOrder", input: { title: `Espejo roto ${RUN}`, priority: "normal", blocksRoom: false }, correlationId: `corr_${RUN}_prop_b` });
    assert.equal(pending.status, "awaiting_confirmation");
    if (pending.status !== "awaiting_confirmation") return;
    const managerInB = context(A, A.propertyB, A.users.generalManager.id, PROPOSER_PERMISSIONS);
    await assert.rejects(confirmToolCall({ context: managerInB, toolCallId: pending.toolCallId, decision: "approve", correlationId: `corr_${RUN}_prop_b_confirm` }), (error: unknown) => error instanceof NotFoundError);
    assert.equal((await prisma.aiToolCall.findUniqueOrThrow({ where: { id: pending.toolCallId } })).status, "awaiting_confirmation");

    const owner = await assertEntityAccess({ userContext: proposer }, { entity: "aiToolCallConfirmation", id: pending.toolCallId });
    assert.equal(owner.propertyId, A.propertyA);
    assert.equal(owner.organizationId, A.organizationId);
    await assert.rejects(assertEntityAccess({ userContext: proposer }, { entity: "aiToolCallConfirmation", id: createWorkOrderCallId }), (error: unknown) => error instanceof NotFoundError, "una fila ya decidida no se resuelve (sin oráculo)");
    await assert.rejects(assertEntityAccess({ userContext: userB }, { entity: "aiToolCallConfirmation", id: pending.toolCallId }), (error: unknown) => error instanceof NotFoundError);

    const rejected = await confirmToolCall({ context: proposer, toolCallId: pending.toolCallId, decision: "reject", notes: "Duplicado", correlationId: `corr_${RUN}_prop_b_reject` });
    assert.equal(rejected.status, "rejected");
    await assert.rejects(assertEntityAccess({ userContext: proposer }, { entity: "aiToolCallConfirmation", id: pending.toolCallId }), (error: unknown) => error instanceof NotFoundError, "rechazada → tampoco se resuelve");
  });

  it("corrección 1 · CFC-05 / SEC-09: runEvaluation con clave simulada → completed con una fila runAiSafetyEvaluation por caso (modelo, coste) y auditoría ai; aiEnabled=false → skipped sin filas; presupuesto agotado → skipped", async () => {
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED_ENV, fetchImpl: fakeFetch(captured, (body) => anthropicText("Con mucho gusto le ayudo; recepción confirmará los detalles.", String(body.model))) });
    const rowsBefore = await prisma.aiToolCall.count({ where: { organizationId: A.organizationId, toolName: "runAiSafetyEvaluation" } });
    const create = () => prisma.aiEvaluation.create({ data: { organizationId: A.organizationId, propertyId: A.propertyA, evaluationName: `Eval ${RUN}`, evaluationType: "safety", promptCode: "guest_message_reply", status: "pending" }, select: { id: true } });
    try {
      const first = await create();
      const ran = await runEvaluation(first.id);
      assert.equal(ran.status, "completed", JSON.stringify(ran.results).slice(0, 300));
      assert.equal(ran.sampleSize, 5);
      assert.equal(captured.length, 5, "un fetch por caso");
      const rows = await prisma.aiToolCall.findMany({ where: { organizationId: A.organizationId, toolName: "runAiSafetyEvaluation" }, orderBy: { createdAt: "asc" } });
      assert.equal(rows.length, rowsBefore + 5, "una fila ai_tool_calls por caso: el presupuesto y el panel ven el gasto");
      for (const row of rows.slice(-5)) {
        assert.equal(row.status, "succeeded");
        assert.equal(row.model, "claude-sonnet-5");
        assert.equal(row.propertyId, A.propertyA);
        assert.equal(Number(row.costEur), 0.00063);
        assert.equal((row.inputJson as { evaluationId?: string }).evaluationId, first.id);
      }
      await flushAuditQueues();
      const audits = await prisma.auditEvent.count({ where: { organizationId: A.organizationId, entityType: "ai_tool_call", entityId: { in: rows.slice(-5).map((row) => row.id) }, actorType: "ai", action: "AI_TOOL_EXECUTED" } });
      assert.equal(audits, 5);

      await prisma.propertyAiSetting.upsert({ where: { propertyId: A.propertyA }, create: { propertyId: A.propertyA, aiEnabled: false, voiceLocales: ["es-ES"] }, update: { aiEnabled: false } });
      const second = await create();
      const off = await runEvaluation(second.id);
      assert.equal(off.status, "skipped");
      assert.match(String(off.results.reason), /IA desactivada en esta propiedad/);
      assert.equal(captured.length, 5, "con la IA apagada no se llama al modelo");

      await prisma.propertyAiSetting.update({ where: { propertyId: A.propertyA }, data: { aiEnabled: true, configurationJson: { monthlyBudgetEur: 0.001 } } });
      const third = await create();
      const exhausted = await runEvaluation(third.id);
      assert.equal(exhausted.status, "skipped");
      assert.match(String(exhausted.results.reason), /Presupuesto mensual de IA agotado/);
      assert.equal(captured.length, 5);
      assert.equal(await prisma.aiToolCall.count({ where: { organizationId: A.organizationId, toolName: "runAiSafetyEvaluation" } }), rowsBefore + 5);
    } finally {
      await prisma.propertyAiSetting.update({ where: { propertyId: A.propertyA }, data: { aiEnabled: true, configurationJson: {} } });
    }
  });
});
