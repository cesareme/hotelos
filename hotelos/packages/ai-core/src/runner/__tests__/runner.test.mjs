// Tool runner con HITL: matriz de puertas con ports falsos en memoria (sin
// Prisma, sin red). Cada rama registra una fila en ai_tool_calls y una entrada
// de auditoría con actorType "ai".
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_DEFINITIONS, canExecuteToolForModules } from "@hotelos/ai-tools";
import { HOTEL_MODULE_CODES } from "@hotelos/product";

import { AiError } from "../../errors.ts";
import { WRITE_ALWAYS_CONFIRMS, evaluateToolGates, runTool, sanitizeForTelemetry, unwrapExecuteResult } from "../runner.ts";
import { runnerContextFromToolContext } from "../types.ts";

globalThis.fetch = () => {
  throw new Error("red prohibida");
};

const ALL_PERMISSIONS = [...new Set(TOOL_DEFINITIONS.flatMap((definition) => definition.requiredPermissions))];

function context(overrides = {}) {
  return {
    organizationId: "org_test",
    propertyId: "prop_test",
    userId: "usr_test",
    permissions: ALL_PERMISSIONS,
    enabledModules: [...HOTEL_MODULE_CODES],
    correlationId: "corr_test",
    source: "text",
    locale: "es-ES",
    ...overrides
  };
}

/** Ports falsos: estado en memoria e inspección de lo registrado. */
function fakePorts(overrides = {}) {
  const state = {
    rows: [],
    patches: [],
    audits: [],
    reviews: [],
    closed: [],
    property: { aiEnabled: true, defaultAutomationLevel: "suggest_and_confirm", monthlyBudgetEur: 25 },
    toolSettings: new Map(),
    gate: { allowed: true, requiresConfirmation: false, requiresHumanReview: false, reasons: ["No policy gate triggered; action permitted."] },
    mtdEur: 0,
    ...overrides
  };
  let seq = 0;
  const ports = {
    getDefinition: (name) => TOOL_DEFINITIONS.find((definition) => definition.name === name) ?? null,
    canExecute: (input) => canExecuteToolForModules(input),
    getPropertySetting: async () => state.property,
    getToolSetting: async (_propertyId, toolName) => state.toolSettings.get(toolName) ?? null,
    evaluatePolicyGate: async (input) => {
      state.lastGateInput = input;
      return state.gate;
    },
    monthToDateCostEur: async () => state.mtdEur,
    recordToolCall: async (input) => {
      const row = { id: `call_${++seq}`, ...input };
      state.rows.push(row);
      return { id: row.id };
    },
    updateToolCall: async (id, patch, guard) => {
      state.patches.push({ id, ...patch, ...(guard ? { guard } : {}) });
      return { count: 1 };
    },
    enqueueReview: async (input) => {
      state.reviews.push(input);
      return { id: `rev_${state.reviews.length}` };
    },
    closeReview: async (relatedEntityId, decision, userId, notes) => {
      state.closed.push({ relatedEntityId, decision, userId, notes });
    },
    audit: (input) => {
      state.audits.push(input);
    }
  };
  return { ports, state };
}

const NOOP = async () => ({ ok: true });

test("escritura con nivel autonomous → awaiting_confirmation y execute NO llamado (100 % escrituras con confirmación)", async () => {
  assert.equal(WRITE_ALWAYS_CONFIRMS, true);
  const { ports, state } = fakePorts({ property: { aiEnabled: true, defaultAutomationLevel: "autonomous", monthlyBudgetEur: 25 } });
  let executed = 0;
  const result = await runTool({
    toolName: "assignRoom",
    input: { reservationId: "res_1", roomId: "room_1" },
    ctx: context(),
    execute: async () => {
      executed += 1;
      return { ok: true };
    },
    preview: (input) => ({ action: "assignRoom", ...input }),
    ports
  });
  assert.equal(result.status, "awaiting_confirmation");
  assert.equal(executed, 0);
  assert.deepEqual(result.preview, { action: "assignRoom", reservationId: "res_1", roomId: "room_1" });
  assert.equal(state.rows.length, 1);
  const row = state.rows[0];
  assert.equal(row.status, "awaiting_confirmation");
  assert.equal(row.toolName, "assignRoom");
  assert.equal(row.requiredConfirmation, true);
  assert.equal(row.automationLevel, "autonomous");
  assert.equal(row.tokensInput, 0);
  assert.equal(row.costEur, 0);
  assert.deepEqual(row.outputJson.proposal, { action: "assignRoom", reservationId: "res_1", roomId: "room_1" });
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0].actorType, "ai");
  assert.equal(state.audits[0].action, "AI_TOOL_CONFIRMATION_REQUESTED");
  assert.equal(state.audits[0].entityType, "ai_tool_call");
  assert.equal(state.audits[0].entityId, row.id);
  // assignRoom es medium y el gate no pide revisión humana: sin cola de revisión.
  assert.equal(state.reviews.length, 0);
});

test("lectura con suggest_and_confirm → executed inmediato con fila succeeded y audit ai", async () => {
  const { ports, state } = fakePorts();
  const result = await runTool({
    toolName: "findReservation",
    input: { code: "RES-1" },
    ctx: context(),
    execute: async (input) => ({ reservation: { code: input.code } }),
    ports
  });
  assert.equal(result.status, "executed");
  assert.equal(result.configured, true);
  assert.deepEqual(result.output, { reservation: { code: "RES-1" } });
  const row = state.rows[0];
  assert.equal(row.status, "succeeded");
  assert.equal(row.requiredConfirmation, false);
  assert.equal(row.automationLevel, "suggest_and_confirm");
  assert.equal(row.tokensInput, 0);
  assert.equal(row.tokensOutput, 0);
  assert.equal(row.costEur, 0, "sin llamada al modelo el coste real es 0");
  assert.equal(row.model, undefined);
  assert.deepEqual(row.outputJson.output, { reservation: { code: "RES-1" } });
  assert.equal(state.audits[0].action, "AI_TOOL_EXECUTED");
  assert.equal(state.audits[0].actorType, "ai");
  assert.equal(state.lastGateInput.automationLevel, "confirm", "el gate recibe el vocabulario normalizado");
  assert.equal(state.lastGateInput.toolRiskLevel, "low");
});

test("borrador (effect read, requiresConfirmation true) → executed con requiredConfirmation true en la fila", async () => {
  const { ports, state } = fakePorts();
  const result = await runTool({
    toolName: "draftReviewResponse",
    input: { reviewText: "Todo perfecto" },
    ctx: context(),
    execute: async () => ({ draft: "Gracias por su visita." }),
    ports
  });
  assert.equal(result.status, "executed");
  assert.equal(state.rows[0].status, "succeeded");
  assert.equal(state.rows[0].requiredConfirmation, true, "la persona revisa el borrador antes de usarlo");
  assert.equal(state.rows[0].automationLevel, "suggest_and_confirm");
});

test("aiEnabled false → denied ai_disabled_for_property, fila rejected y audit actorType ai", async () => {
  const { ports, state } = fakePorts({ property: { aiEnabled: false, defaultAutomationLevel: "suggest_and_confirm", monthlyBudgetEur: 25 } });
  let executed = 0;
  const result = await runTool({ toolName: "findReservation", input: {}, ctx: context(), execute: async () => (executed += 1), ports });
  assert.equal(result.status, "denied");
  assert.equal(result.reason, "ai_disabled_for_property");
  assert.equal(result.riskLevel, "low");
  assert.match(result.message, /IA desactivada/);
  assert.equal(executed, 0);
  assert.equal(state.rows[0].status, "rejected");
  assert.equal(state.rows[0].errorMessage, "ai_disabled_for_property");
  assert.equal(state.rows[0].costEur, 0);
  assert.equal(result.toolCallId, state.rows[0].id);
  assert.equal(state.audits[0].actorType, "ai");
  assert.equal(state.audits[0].action, "AI_TOOL_DENIED");
});

test("tool.enabled false y nivel off → denied tool_disabled", async () => {
  const disabled = fakePorts();
  disabled.state.toolSettings.set("findReservation", { enabled: false, automationLevel: "suggest", requiresConfirmation: true, requiresApprovalRole: null });
  const first = await runTool({ toolName: "findReservation", input: {}, ctx: context(), execute: NOOP, ports: disabled.ports });
  assert.equal(first.status, "denied");
  assert.equal(first.reason, "tool_disabled");

  const off = fakePorts();
  off.state.toolSettings.set("findReservation", { enabled: true, automationLevel: "manual_only", requiresConfirmation: true, requiresApprovalRole: null });
  const second = await runTool({ toolName: "findReservation", input: {}, ctx: context(), execute: NOOP, ports: off.ports });
  assert.equal(second.status, "denied");
  assert.equal(second.reason, "tool_disabled");
  assert.equal(off.state.rows[0].automationLevel, "off");

  const propertyOff = fakePorts({ property: { aiEnabled: true, defaultAutomationLevel: "off", monthlyBudgetEur: 25 } });
  const third = await runTool({ toolName: "findReservation", input: {}, ctx: context(), execute: NOOP, ports: propertyOff.ports });
  assert.equal(third.reason, "tool_disabled");
});

test("módulo apagado → module_disabled; permiso ausente → missing_permission", async () => {
  const noModule = fakePorts();
  const moduleOff = await runTool({ toolName: "getHousekeepingBoard", input: {}, ctx: context({ enabledModules: ["pms_core"] }), execute: NOOP, ports: noModule.ports });
  assert.equal(moduleOff.status, "denied");
  assert.equal(moduleOff.reason, "module_disabled");
  assert.match(moduleOff.message, /housekeeping/);
  assert.equal(noModule.state.rows[0].status, "rejected");

  const noPermission = fakePorts();
  const missing = await runTool({ toolName: "getHousekeepingBoard", input: {}, ctx: context({ permissions: ["ai.tool.execute"] }), execute: NOOP, ports: noPermission.ports });
  assert.equal(missing.status, "denied");
  assert.equal(missing.reason, "missing_permission");
  assert.equal(missing.details.reason, "Missing permission housekeeping.read.");
});

test("safety: storesIdImage → denied safety (nunca se ejecuta ni queda pendiente)", async () => {
  const { ports, state } = fakePorts();
  const result = await runTool({ toolName: "checkInReservation", input: { confirmationId: "c1" }, ctx: context(), facts: { storesIdImage: true }, execute: NOOP, ports });
  assert.equal(result.status, "denied");
  assert.equal(result.reason, "safety");
  assert.equal(result.riskLevel, "critical");
  assert.match(result.message, /ID document images must be discarded/);
  assert.equal(state.rows[0].status, "rejected");
  assert.equal(state.reviews.length, 0);
});

test("safety: hechos de la matriz (habitación bloqueada en assignRoom) → denied safety con la clave mapeada", async () => {
  const { ports } = fakePorts();
  const result = await runTool({ toolName: "assignRoom", input: {}, ctx: context(), facts: { roomBlocked: true }, execute: NOOP, ports });
  assert.equal(result.status, "denied");
  assert.equal(result.reason, "safety");
  assert.equal(result.details.riskKey, "assign_room");
});

test("gate allowed:true con requiresConfirmation:true (política de confianza mínima) → awaiting_confirmation también en lecturas (SEC-08)", async () => {
  const { ports, state } = fakePorts({ gate: { allowed: true, requiresConfirmation: true, requiresHumanReview: false, reasons: ["Confidence 0.10 is below the required threshold 0.85; confirmation required."] } });
  let executed = 0;
  const result = await runTool({ toolName: "draftReviewResponse", input: { reviewText: "x" }, ctx: context(), confidence: 0.1, execute: async () => (executed += 1), ports });
  assert.equal(result.status, "awaiting_confirmation");
  assert.equal(executed, 0);
  assert.equal(state.rows[0].status, "awaiting_confirmation");
  assert.equal(state.rows[0].outputJson.gate.reasons[0], "Confidence 0.10 is below the required threshold 0.85; confirmation required.");
});

test("telemetría sin PII (SEC-06): inputJson y outputJson.output llevan marcadores; la fila pendiente conserva la entrada ejecutable", async () => {
  const text = "Carta de la Sra. Ludmila Ferreiro, DNI 12345678Z, tel 612 345 678, ana@example.com, tarjeta 4111 1111 1111 1111";
  const { ports, state } = fakePorts();
  const result = await runTool({ toolName: "classifyIncomingDocument", input: { text }, ctx: context(), execute: async () => ({ output: { kind: "letter", note: "Remite: Ludmila Ferreiro, 612 345 678" } }), ports });
  assert.equal(result.status, "executed");
  assert.equal(result.output.note, "Remite: Ludmila Ferreiro, 612 345 678", "la salida al llamador no se toca");
  const stored = JSON.stringify(state.rows[0].inputJson);
  for (const raw of ["Ludmila Ferreiro", "12345678Z", "612 345 678", "ana@example.com", "4111 1111 1111 1111"]) assert.ok(!stored.includes(raw), `inputJson conserva ${raw}`);
  assert.equal(state.rows[0].inputJson.text, "Carta de la Sra. [NOMBRE_1], DNI [DOC_1], tel [TEL_1], [EMAIL_1], tarjeta [TARJETA_1]");
  assert.equal(state.rows[0].outputJson.output.note, "Remite: [NOMBRE_1], [TEL_1]");

  // Escritura pendiente: la persona debe ver la propuesta real y la confirmación ejecuta esa entrada.
  const pending = fakePorts();
  await runTool({ toolName: "sendGuestMessage", input: { conversationId: "conv_1", body: "Hola Sra. Ludmila Ferreiro, la esperamos." }, ctx: context(), execute: NOOP, preview: (input) => ({ body: input.body }), ports: pending.ports });
  assert.equal(pending.state.rows[0].status, "awaiting_confirmation");
  assert.equal(pending.state.rows[0].inputJson.body, "Hola Sra. Ludmila Ferreiro, la esperamos.");
  assert.equal(pending.state.rows[0].outputJson.proposal.body, "Hola Sra. Ludmila Ferreiro, la esperamos.");
});

test("AiError con telemetría (invalid_output/truncated tras una respuesta facturada) → fila failed con modelo, tokens y coste (CFC-02)", async () => {
  const { ports, state } = fakePorts();
  const telemetry = { model: "claude-sonnet-5", tokensInput: 1200, tokensOutput: 150, cacheReadTokens: 0, costUsd: 0.0039, costEur: 0.00351, latencyMs: 40 };
  const result = await runTool({
    toolName: "answerGuestQuestion",
    input: { guestQuestion: "¿Parking?" },
    ctx: context(),
    execute: async () => {
      throw new AiError("invalid_output", "Respuesta del modelo no válida: no contiene un objeto JSON.", { retryable: false, telemetry });
    },
    ports
  });
  assert.equal(result.status, "denied");
  assert.equal(result.reason, "invalid_output");
  const row = state.rows[0];
  assert.equal(row.status, "failed");
  assert.equal(row.model, "claude-sonnet-5");
  assert.equal(row.tokensInput, 1200);
  assert.equal(row.tokensOutput, 150);
  assert.equal(row.costEur, 0.00351);
  assert.equal(row.outputJson.usage.costUsd, 0.0039);
  assert.equal(state.audits[0].afterJson.model, "claude-sonnet-5");
});

test("gate allowed:false → awaiting_confirmation aunque sea una lectura", async () => {
  const { ports, state } = fakePorts({ gate: { allowed: false, requiresConfirmation: true, requiresHumanReview: false, reasons: ["Autonomous execution blocked."] } });
  let executed = 0;
  const result = await runTool({ toolName: "findReservation", input: {}, ctx: context(), execute: async () => (executed += 1), ports });
  assert.equal(result.status, "awaiting_confirmation");
  assert.equal(executed, 0);
  assert.equal(state.rows[0].status, "awaiting_confirmation");
  assert.deepEqual(state.rows[0].outputJson.gate.reasons.slice(0, 1), ["Autonomous execution blocked."]);
  assert.equal(state.rows[0].outputJson.proposal, null, "sin preview la propuesta es null");
});

test("requiresHumanReview → enqueueReview exactamente una vez, ligada a la llamada", async () => {
  const { ports, state } = fakePorts({ gate: { allowed: true, requiresConfirmation: true, requiresHumanReview: true, reasons: ["Human review required."] } });
  const result = await runTool({ toolName: "markRoomClean", input: { roomId: "room_1" }, ctx: context(), execute: NOOP, ports });
  assert.equal(result.status, "awaiting_confirmation");
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].reviewType, "ai_tool_call");
  assert.equal(state.reviews[0].relatedEntityType, "ai_tool_call");
  assert.equal(state.reviews[0].relatedEntityId, result.toolCallId);
  assert.deepEqual(state.reviews[0].payloadJson, { toolName: "markRoomClean", riskLevel: "medium", proposal: null });

  // Riesgo high → cola aunque el gate no lo pida.
  const high = fakePorts();
  const blocked = await runTool({ toolName: "blockRoomForMaintenance", input: { workOrderId: "wo_1" }, ctx: context(), execute: NOOP, ports: high.ports });
  assert.equal(blocked.status, "awaiting_confirmation");
  assert.equal(high.state.reviews.length, 1);
  assert.equal(high.state.reviews[0].payloadJson.riskLevel, "high");
});

test("requiresApprovalRole de la matriz (critical) llega al resultado y a la fila", async () => {
  const { ports, state } = fakePorts();
  const result = await runTool({ toolName: "createCapexProject", input: {}, ctx: context(), execute: NOOP, ports });
  assert.equal(result.status, "awaiting_confirmation");
  assert.equal(result.requiresApprovalRole, "owner");
  assert.equal(state.rows[0].outputJson.requiresApprovalRole, "owner");
  assert.equal(state.reviews.length, 1, "critical → revisión humana");
});

test("presupuesto: mtd 25 ≥ budget 25 → denied budget_exceeded sin execute; budget 0 bloquea; sin límite (null) no bloquea", async () => {
  const exceeded = fakePorts({ mtdEur: 25 });
  let executed = 0;
  const result = await runTool({ toolName: "findReservation", input: {}, ctx: context(), execute: async () => (executed += 1), ports: exceeded.ports });
  assert.equal(result.status, "denied");
  assert.equal(result.reason, "budget_exceeded");
  assert.equal(executed, 0);
  assert.deepEqual(result.details, { budgetEur: 25, spentEur: 25, propertyId: "prop_test" });
  assert.equal(exceeded.state.rows[0].status, "rejected");
  assert.equal(exceeded.state.rows[0].costEur, 0);

  const zero = fakePorts({ property: { aiEnabled: true, defaultAutomationLevel: "suggest", monthlyBudgetEur: 0 }, mtdEur: 0 });
  const blocked = await runTool({ toolName: "findReservation", input: {}, ctx: context(), execute: NOOP, ports: zero.ports });
  assert.equal(blocked.reason, "budget_exceeded");

  const unlimited = fakePorts({ property: { aiEnabled: true, defaultAutomationLevel: "suggest", monthlyBudgetEur: null }, mtdEur: 9_999 });
  const allowed = await runTool({ toolName: "findReservation", input: {}, ctx: context(), execute: NOOP, ports: unlimited.ports });
  assert.equal(allowed.status, "executed");

  const under = fakePorts({ mtdEur: 24.99 });
  const ok = await runTool({ toolName: "findReservation", input: {}, ctx: context(), execute: NOOP, ports: under.ports });
  assert.equal(ok.status, "executed");
});

test("herramienta desconocida → denied tool_unknown (fila rejected con el nombre pedido)", async () => {
  const { ports, state } = fakePorts();
  const result = await runTool({ toolName: "teleportGuest", input: {}, ctx: context(), execute: NOOP, ports });
  assert.equal(result.status, "denied");
  assert.equal(result.reason, "tool_unknown");
  assert.equal(state.rows[0].toolName, "teleportGuest");
  assert.equal(state.rows[0].status, "rejected");
});

test("sin execute → denied tool_not_implemented (honesto: dinero/fiscal sin ejecución)", async () => {
  const { ports, state } = fakePorts();
  const result = await runTool({ toolName: "getFolioBalance", input: { folioId: "f1" }, ctx: context(), ports });
  assert.equal(result.status, "denied");
  assert.equal(result.reason, "tool_not_implemented");
  assert.equal(state.rows[0].status, "rejected");
  assert.equal(state.rows[0].errorMessage, "tool_not_implemented");
});

test("alias legado: recordAs 'scan_id_document' persiste ese nombre y evalúa la definición canónica", async () => {
  const { ports, state } = fakePorts();
  const result = await runTool({
    toolName: "scan_id_document",
    recordAs: "scan_id_document",
    input: { imageDataUrl: "data:image/png;base64," + "A".repeat(4_000) },
    ctx: context(),
    execute: async () => ({ configured: true, provider: "anthropic", model: "claude-sonnet-5", usage: { tokensInput: 10, tokensOutput: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, tokensInput: 10, tokensOutput: 5, costUsd: 0.0001, costEur: 0.00009, latencyMs: 12, stopReason: "end_turn", truncated: false, toolUses: [], fields: {}, confidence: {} }),
    ports
  });
  assert.equal(result.status, "executed");
  assert.equal(state.rows[0].toolName, "scan_id_document");
  assert.equal(state.rows[0].requiredConfirmation, true, "extractGuestIdentityFieldsTemporary exige revisión del resultado");
  assert.match(state.rows[0].inputJson.imageDataUrl, /^data:image\/png;base64,<omitido 4000 caracteres>$/, "inputJson sin bytes ni base64");
  assert.equal(state.rows[0].model, "claude-sonnet-5");
  assert.equal(state.rows[0].tokensInput, 10);
  assert.equal(state.rows[0].costEur, 0.00009);
  assert.equal(state.rows[0].outputJson.usage.costUsd, 0.0001);
  assert.equal(state.audits[0].afterJson.toolName, "extractGuestIdentityFieldsTemporary");
  assert.equal(state.audits[0].afterJson.recordedAs, "scan_id_document");
});

test("legacyStatus { succeeded:'completed', notConfigured:'skipped' } se persiste tal cual", async () => {
  const ok = fakePorts();
  await runTool({ toolName: "guest_message_reply", recordAs: "guest_message_reply", legacyStatus: { succeeded: "completed", notConfigured: "skipped" }, input: { guestQuestion: "¿Hay parking?" }, ctx: context({ conversationId: "conv_1" }), execute: async () => ({ text: "Sí." }), ports: ok.ports });
  assert.equal(ok.state.rows[0].status, "completed");
  assert.equal(ok.state.rows[0].toolName, "guest_message_reply");
  assert.equal(ok.state.rows[0].conversationId, "conv_1");

  const skipped = fakePorts();
  const result = await runTool({ toolName: "guest_message_reply", recordAs: "guest_message_reply", legacyStatus: { succeeded: "completed", notConfigured: "skipped" }, input: {}, ctx: context(), execute: async () => ({ configured: false, reason: "not_configured", message: "Sin modelo configurado" }), ports: skipped.ports });
  assert.equal(result.status, "executed");
  assert.equal(result.configured, false);
  assert.equal(skipped.state.rows[0].status, "skipped");
});

test("execute que devuelve configured:false → skipped con errorMessage = reason, tokens 0 y costEur 0", async () => {
  const { ports, state } = fakePorts();
  const result = await runTool({ toolName: "analyzeReviewSentiment", input: { text: "Muy bien" }, ctx: context(), execute: async () => ({ configured: false, reason: "not_configured", message: "Sin modelo configurado" }), ports });
  assert.equal(result.status, "executed");
  assert.equal(result.configured, false);
  assert.equal(state.rows[0].status, "skipped");
  assert.equal(state.rows[0].errorMessage, "not_configured");
  assert.equal(state.rows[0].tokensInput, 0);
  assert.equal(state.rows[0].tokensOutput, 0);
  assert.equal(state.rows[0].costEur, 0);
  assert.equal(state.rows[0].model, undefined);
  assert.deepEqual(state.rows[0].outputJson, { configured: false, reason: "not_configured", message: "Sin modelo configurado" });
});

test("execute que lanza AiError → fila failed con el código en errorMessage y resultado denied con ese código", async () => {
  const { ports, state } = fakePorts();
  const result = await runTool({
    toolName: "analyzeReviewSentiment",
    input: { text: "x" },
    ctx: context(),
    execute: async () => {
      throw new AiError("rate_limited", "Límite de peticiones de IA alcanzado", { retryable: true, status: 429, retryAfterMs: 1500 });
    },
    ports
  });
  assert.equal(result.status, "denied");
  assert.equal(result.reason, "rate_limited");
  assert.equal(result.details.retryAfterMs, 1500);
  assert.equal(state.rows[0].status, "failed");
  assert.match(state.rows[0].errorMessage, /^rate_limited: /);
  assert.equal(state.rows[0].costEur, undefined, "coste desconocido → columna nula, nunca fabricado");
  assert.equal(state.audits[0].action, "AI_TOOL_FAILED");
});

test("execute que lanza un error genérico → fila failed y el error se relanza", async () => {
  const { ports, state } = fakePorts();
  await assert.rejects(
    runTool({
      toolName: "findReservation",
      input: {},
      ctx: context(),
      execute: async () => {
        throw new Error("Reserva no encontrada.");
      },
      ports
    }),
    /Reserva no encontrada/
  );
  assert.equal(state.rows[0].status, "failed");
  assert.equal(state.rows[0].errorMessage, "Reserva no encontrada.");
});

test("costEur null cuando el execute devuelve usage sin tipo de cambio: columna nula y costUsd en outputJson.usage", async () => {
  const { ports, state } = fakePorts();
  await runTool({
    toolName: "classifyIncomingDocument",
    input: { text: "Factura 123" },
    ctx: context(),
    execute: async () => ({
      output: { kind: "invoice", confidence: 0.9 },
      telemetry: { model: "claude-haiku-4-5-20251001", tokensInput: 120, tokensOutput: 30, cacheReadTokens: 0, costUsd: 0.00027, costEur: null, latencyMs: 300 }
    }),
    ports
  });
  const row = state.rows[0];
  assert.equal(row.status, "succeeded");
  assert.equal(row.model, "claude-haiku-4-5-20251001");
  assert.equal(row.tokensInput, 120);
  assert.equal(row.tokensOutput, 30);
  assert.equal(row.costEur, undefined);
  assert.equal(row.outputJson.usage.costUsd, 0.00027);
  assert.equal(row.outputJson.usage.costEur, null);
  assert.deepEqual(row.outputJson.output, { kind: "invoice", confidence: 0.9 });
});

test("record: lo envuelto en { output, record } persiste `record` (sin PII) y devuelve `output`", async () => {
  const { ports, state } = fakePorts();
  const result = await runTool({ toolName: "matchGuestToReservation", input: { documentFields: { documentNumber: "12345678Z" } }, ctx: context(), execute: async () => ({ output: { guest: { id: "g1", firstName: "Nombre" }, reservation: { id: "r1" } }, record: { guestId: "g1", reservationId: "r1" } }), ports });
  assert.equal(result.status, "executed");
  assert.equal(result.output.guest.firstName, "Nombre");
  assert.deepEqual(state.rows[0].outputJson.output, { guestId: "g1", reservationId: "r1" });
});

test("refusal (configured:false con telemetría) → failed con coste real registrado", async () => {
  const { ports, state } = fakePorts();
  const result = await runTool({ toolName: "analyzeReviewSentiment", input: { text: "x" }, ctx: context(), execute: async () => ({ configured: false, reason: "refusal", message: "El modelo rechazó la petición", telemetry: { model: "claude-sonnet-5", tokensInput: 50, tokensOutput: 2, cacheReadTokens: 0, costUsd: 0.00012, costEur: 0.0001, latencyMs: 80 } }), ports });
  assert.equal(result.status, "executed");
  assert.equal(result.configured, false);
  assert.equal(state.rows[0].status, "failed");
  assert.match(state.rows[0].errorMessage, /^refusal: /);
  assert.equal(state.rows[0].costEur, 0.0001);
  assert.equal(state.rows[0].tokensInput, 50);
});

test("evaluateToolGates no registra nada y expone la decisión (modo, nivel, presupuesto, seguridad)", async () => {
  const { ports, state } = fakePorts({ mtdEur: 3.5 });
  const decision = await evaluateToolGates({ toolName: "createHousekeepingTask", ctx: context(), ports });
  assert.equal(decision.mode, "confirm");
  assert.equal(decision.definition.effect, "write");
  assert.equal(decision.automationLevel, "suggest_and_confirm");
  assert.deepEqual(decision.budget, { budgetEur: 25, spentEur: 3.5 });
  assert.equal(decision.safety.riskKey, "create_housekeeping_task");
  assert.equal(decision.requiresHumanReview, false);
  assert.equal(state.rows.length, 0);
  assert.equal(state.audits.length, 0);

  const read = await evaluateToolGates({ toolName: "getHousekeepingBoard", ctx: context(), ports });
  assert.equal(read.mode, "execute");
  assert.equal(read.requiredConfirmation, false);
});

test("runnerContextFromToolContext traduce auditCorrelationId y copia permisos/módulos", () => {
  const ctx = runnerContextFromToolContext({ organizationId: "o", propertyId: "p", userId: "u", locale: "es", source: "chat", auditCorrelationId: "corr_9", permissions: ["ai.tool.execute"], deviceId: "dev_1" }, ["pms_core"]);
  assert.deepEqual(ctx, { organizationId: "o", propertyId: "p", userId: "u", permissions: ["ai.tool.execute"], enabledModules: ["pms_core"], correlationId: "corr_9", source: "chat", locale: "es", deviceId: "dev_1" });
});

test("sanitizeForTelemetry elimina bytes y base64; unwrapExecuteResult distingue desnudo, envuelto y no configurado", () => {
  const cleaned = sanitizeForTelemetry({ imageDataUrl: "data:image/jpeg;base64,/9j/" + "B".repeat(3_000), pdfBase64: "Q".repeat(5_000), buffer: Buffer.from("abc"), nested: [{ ok: true, when: new Date("2026-09-18T00:00:00Z") }], fn: () => 1, short: "hola" });
  assert.equal(cleaned.imageDataUrl, "data:image/jpeg;base64,<omitido 3004 caracteres>");
  assert.equal(cleaned.pdfBase64, "<base64 omitido, 5000 caracteres>");
  assert.deepEqual(cleaned.buffer, { bytes: 3 });
  assert.deepEqual(cleaned.nested, [{ ok: true, when: "2026-09-18T00:00:00.000Z" }]);
  assert.equal(cleaned.fn, undefined);
  assert.equal(cleaned.short, "hola");

  assert.deepEqual(unwrapExecuteResult({ a: 1 }), { output: { a: 1 }, telemetry: null, record: undefined, notConfigured: null, refused: null });
  const wrapped = unwrapExecuteResult({ output: { a: 1 }, telemetry: { model: "m", tokensInput: 1, tokensOutput: 1, cacheReadTokens: 0, costUsd: null, costEur: null, latencyMs: 1 }, record: { a: "x" } });
  assert.equal(wrapped.telemetry.model, "m");
  assert.deepEqual(wrapped.record, { a: "x" });
  const off = unwrapExecuteResult({ configured: false });
  assert.deepEqual(off.notConfigured, { reason: "not_configured", message: "Sin modelo configurado" });
});
