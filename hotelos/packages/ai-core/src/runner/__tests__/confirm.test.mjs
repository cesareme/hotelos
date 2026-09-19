// confirmTool: decisión humana sobre una llamada awaiting_confirmation. Ports
// falsos en memoria; la ejecución usa el inputJson guardado en la fila.
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_DEFINITIONS, canExecuteToolForModules } from "@hotelos/ai-tools";

import { AiError } from "../../errors.ts";
import { CONFIRMATION_EXPIRED_MESSAGE, CONFIRMATION_TTL_MS, HIGH_RISK_CONFIRM_PERMISSION, TOOL_CALL_NOT_FOUND_MESSAGE, confirmTool } from "../runner.ts";

globalThis.fetch = () => {
  throw new Error("red prohibida");
};

const ALL_PERMISSIONS = [...new Set(TOOL_DEFINITIONS.flatMap((definition) => definition.requiredPermissions))];

function context(overrides = {}) {
  return { organizationId: "org_test", propertyId: "prop_test", userId: "usr_confirm", permissions: ALL_PERMISSIONS, enabledModules: ["pms_core", "housekeeping", "maintenance"], correlationId: "corr_confirm", source: "text", locale: "es-ES", ...overrides };
}

function storedRow(overrides = {}) {
  return {
    id: "call_1",
    organizationId: "org_test",
    propertyId: "prop_test",
    userId: "usr_test",
    toolName: "assignRoom",
    status: "awaiting_confirmation",
    inputJson: { reservationId: "res_1", roomId: "room_1" },
    outputJson: { proposal: { action: "assignRoom" }, effect: "write" },
    requiredConfirmation: true,
    automationLevel: "suggest_and_confirm",
    ...overrides
  };
}

function fakePorts(options = {}) {
  // `claimed` simula la guarda condicional del API (UPDATE … WHERE status = awaiting_confirmation AND confirmed_by IS NULL):
  // la primera escritura con guard.unclaimed reclama la fila; las siguientes devuelven count 0.
  const state = { patches: [], audits: [], closed: [], claimed: new Set(), property: { aiEnabled: true, defaultAutomationLevel: "suggest_and_confirm", monthlyBudgetEur: 25 }, toolSetting: null, mtdEur: 0 };
  const conflictOnClose = options.conflictOnClose ?? false;
  const ports = {
    getDefinition: (name) => TOOL_DEFINITIONS.find((definition) => definition.name === name) ?? null,
    canExecute: (input) => canExecuteToolForModules(input),
    getPropertySetting: async () => state.property,
    getToolSetting: async () => state.toolSetting,
    evaluatePolicyGate: async () => ({ allowed: true, requiresConfirmation: false, requiresHumanReview: false, reasons: [] }),
    monthToDateCostEur: async () => state.mtdEur,
    recordToolCall: async () => ({ id: "unused" }),
    updateToolCall: async (id, patch, guard) => {
      if (guard?.unclaimed) {
        if (state.claimed.has(id)) return { count: 0 };
        state.claimed.add(id);
      }
      state.patches.push({ id, ...patch, ...(guard ? { guard } : {}) });
      return { count: 1 };
    },
    enqueueReview: async () => ({ id: "unused" }),
    // Simula el port del API: approveReview/rejectReview lanzan ConflictError si la revisión ya
    // estaba decidida y el port lo captura (patrón email-reservation.service.ts:585-591).
    closeReview: async (relatedEntityId, decision, userId, notes) => {
      state.closed.push({ relatedEntityId, decision, userId, notes });
      if (conflictOnClose) {
        try {
          throw Object.assign(new Error("No se puede aprobar un elemento de revisión en estado \"approved\"."), { name: "ConflictError", statusCode: 409 });
        } catch (error) {
          if (!(error instanceof Error && error.name === "ConflictError")) throw error;
          state.closed[state.closed.length - 1].alreadyDecided = true;
        }
      }
    },
    audit: (input) => {
      state.audits.push(input);
    }
  };
  return { ports, state };
}

test("approve ejecuta con el inputJson guardado → succeeded + confirmedBy + closeReview approved (ConflictError tolerado) y auditoría user + ai", async () => {
  const { ports, state } = fakePorts({ conflictOnClose: true });
  const row = storedRow();
  const seen = [];
  const result = await confirmTool({
    toolCallId: "call_1",
    ctx: context(),
    decision: "approve",
    notes: "Habitación revisada",
    execute: async (input, ctx) => {
      seen.push({ input, userId: ctx.userId });
      return { assigned: true, reservationId: input.reservationId };
    },
    ports,
    loadToolCall: async (id) => (id === row.id ? row : null)
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.configured, true);
  assert.deepEqual(result.output, { assigned: true, reservationId: "res_1" });
  assert.deepEqual(seen, [{ input: { reservationId: "res_1", roomId: "room_1" }, userId: "usr_confirm" }]);

  assert.equal(state.patches.length, 2, "reclamación condicional + cierre");
  assert.deepEqual(state.patches[0], { id: "call_1", confirmedBy: "usr_confirm", guard: { status: "awaiting_confirmation", unclaimed: true } });
  const patch = state.patches[1];
  assert.equal(patch.id, "call_1");
  assert.equal(patch.status, "succeeded");
  assert.equal(patch.confirmedBy, "usr_confirm");
  assert.equal(patch.tokensInput, 0);
  assert.equal(patch.costEur, 0, "sin llamada al modelo: coste real 0");
  assert.equal(patch.errorMessage, null);
  assert.deepEqual(patch.outputJson.execution, { assigned: true, reservationId: "res_1" });
  assert.deepEqual(patch.outputJson.proposal, { action: "assignRoom" }, "conserva la propuesta previa");
  assert.equal(patch.outputJson.confirmation.decision, "approve");
  assert.equal(patch.outputJson.confirmation.notes, "Habitación revisada");

  assert.equal(state.closed.length, 1);
  assert.equal(state.closed[0].decision, "approved");
  assert.equal(state.closed[0].relatedEntityId, "call_1");
  assert.equal(state.closed[0].alreadyDecided, true, "la revisión ya decidida no rompe la confirmación");

  assert.deepEqual(state.audits.map((audit) => [audit.actorType, audit.action]), [
    ["user", "AI_TOOL_CONFIRMATION_APPROVED"],
    ["ai", "AI_TOOL_EXECUTED"]
  ]);
  assert.equal(state.audits[0].actorUserId, "usr_confirm");
  assert.equal(state.audits[1].entityId, "call_1");
  assert.equal(state.audits[1].entityType, "ai_tool_call");
});

test("approve con telemetría del modelo persiste model/tokens/coste en la fila", async () => {
  const { ports, state } = fakePorts();
  const row = storedRow({ toolName: "sendGuestMessage", inputJson: { conversationId: "conv_1", body: "Hola" } });
  const result = await confirmTool({
    toolCallId: "call_1",
    ctx: context({ enabledModules: ["ai_concierge"] }),
    decision: "approve",
    execute: async () => ({ output: { messageId: "msg_1" }, telemetry: { model: "claude-sonnet-5", tokensInput: 40, tokensOutput: 20, cacheReadTokens: 0, costUsd: 0.00028, costEur: 0.00025, latencyMs: 100 } }),
    ports,
    loadToolCall: async () => row
  });
  assert.equal(result.status, "succeeded");
  assert.equal(state.patches[1].model, "claude-sonnet-5");
  assert.equal(state.patches[1].tokensInput, 40);
  assert.equal(state.patches[1].costEur, 0.00025);
  assert.equal(state.patches[1].outputJson.usage.costUsd, 0.00028);
});

test("reject → rejected + confirmedBy + closeReview rejected sin ejecutar", async () => {
  const { ports, state } = fakePorts();
  let executed = 0;
  const result = await confirmTool({
    toolCallId: "call_1",
    ctx: context(),
    decision: "reject",
    notes: "No procede",
    execute: async () => (executed += 1),
    ports,
    loadToolCall: async () => storedRow()
  });
  assert.equal(result.status, "rejected");
  assert.equal(executed, 0);
  assert.equal(state.patches.length, 1, "el rechazo es una única transición condicional");
  assert.equal(state.patches[0].status, "rejected");
  assert.equal(state.patches[0].confirmedBy, "usr_confirm");
  assert.equal(state.patches[0].errorMessage, "Rechazada por el usuario: No procede");
  assert.deepEqual(state.patches[0].guard, { status: "awaiting_confirmation", unclaimed: true });
  assert.deepEqual(state.closed, [{ relatedEntityId: "call_1", decision: "rejected", userId: "usr_confirm", notes: "No procede" }]);
  assert.deepEqual(state.audits.map((audit) => [audit.actorType, audit.action]), [["user", "AI_TOOL_CONFIRMATION_REJECTED"]]);
});

test("fila inexistente, no awaiting o de otra organización → not found opaco (AiError tool_unknown, 404)", async () => {
  const { ports, state } = fakePorts();
  for (const load of [async () => null, async () => storedRow({ status: "succeeded" }), async () => storedRow({ status: "pending" }), async () => storedRow({ organizationId: "org_other" })]) {
    await assert.rejects(confirmTool({ toolCallId: "call_1", ctx: context(), decision: "approve", execute: async () => ({}), ports, loadToolCall: load }), (error) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, "tool_unknown");
      assert.equal(error.status, 404);
      assert.equal(error.message, TOOL_CALL_NOT_FOUND_MESSAGE);
      return true;
    });
  }
  assert.equal(state.patches.length, 0);
  assert.equal(state.audits.length, 0);
});

test("high/critical exige ai.high_risk.confirm además de los permisos de la definición", async () => {
  const { ports, state } = fakePorts();
  const row = storedRow({ toolName: "blockRoomForMaintenance", inputJson: { workOrderId: "wo_1" } });
  const withoutHighRisk = ALL_PERMISSIONS.filter((permission) => permission !== HIGH_RISK_CONFIRM_PERMISSION);
  await assert.rejects(confirmTool({ toolCallId: "call_1", ctx: context({ permissions: withoutHighRisk }), decision: "approve", execute: async () => ({}), ports, loadToolCall: async () => row }), (error) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, "tool_denied");
    assert.equal(error.status, 403);
    assert.deepEqual(error.details, { missing: ["ai.high_risk.confirm"] });
    return true;
  });
  assert.equal(state.patches.length, 0);

  // Sin el permiso de la propia definición tampoco (medium: no exige high_risk).
  await assert.rejects(confirmTool({ toolCallId: "call_1", ctx: context({ permissions: ["ai.tool.execute"] }), decision: "approve", execute: async () => ({}), ports, loadToolCall: async () => storedRow() }), (error) => {
    assert.equal(error.code, "tool_denied");
    assert.deepEqual(error.details, { missing: ["pms.reservation.modify"] });
    return true;
  });

  // Con todos los permisos, la escritura high se ejecuta.
  const ok = await confirmTool({ toolCallId: "call_1", ctx: context(), decision: "approve", execute: async () => ({ blocked: true }), ports, loadToolCall: async () => row });
  assert.equal(ok.status, "succeeded");
});

test("approve cuya ejecución lanza AiError → failed con código, revisión cerrada como aprobada y auditoría ai de fallo", async () => {
  const { ports, state } = fakePorts();
  const result = await confirmTool({
    toolCallId: "call_1",
    ctx: context(),
    decision: "approve",
    execute: async () => {
      throw new AiError("provider_error", "Error del proveedor de IA", { retryable: true, status: 502 });
    },
    ports,
    loadToolCall: async () => storedRow()
  });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "provider_error");
  assert.equal(state.patches[1].status, "failed");
  assert.match(state.patches[1].errorMessage, /^provider_error: /);
  assert.equal(state.closed[0].decision, "approved");
  assert.deepEqual(state.audits.map((audit) => audit.action), ["AI_TOOL_CONFIRMATION_APPROVED", "AI_TOOL_FAILED"]);

  // Error genérico: se registra failed y se relanza.
  const generic = fakePorts();
  await assert.rejects(
    confirmTool({
      toolCallId: "call_1",
      ctx: context(),
      decision: "approve",
      execute: async () => {
        throw new Error("Reserva o habitación no encontrada.");
      },
      ports: generic.ports,
      loadToolCall: async () => storedRow()
    }),
    /Reserva o habitación no encontrada/
  );
  assert.equal(generic.state.patches[1].status, "failed");
});

test("approve cuya ejecución devuelve configured:false → failed honesto (sin modelo) con coste 0", async () => {
  const { ports, state } = fakePorts();
  const result = await confirmTool({ toolCallId: "call_1", ctx: context(), decision: "approve", execute: async () => ({ configured: false, reason: "not_configured", message: "Sin modelo configurado" }), ports, loadToolCall: async () => storedRow() });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "not_configured");
  assert.equal(state.patches[1].status, "failed");
  assert.equal(state.patches[1].costEur, 0);
  assert.deepEqual(state.patches[1].outputJson.execution, { configured: false, reason: "not_configured", message: "Sin modelo configurado" });
});

// --- Corrección 1 (seguridad-pii-hitl) -------------------------------------------------

test("SEC-02: dos aprobaciones concurrentes de la misma fila ejecutan UNA sola vez; la segunda recibe el 404 opaco", async () => {
  const { ports, state } = fakePorts();
  const row = storedRow({ toolName: "sendGuestMessage", inputJson: { conversationId: "conv_1", body: "Hola" } });
  let executed = 0;
  const approve = () =>
    confirmTool({
      toolCallId: "call_1",
      ctx: context({ enabledModules: ["ai_concierge"] }),
      decision: "approve",
      execute: async () => {
        executed += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { sent: executed };
      },
      ports,
      loadToolCall: async () => ({ ...row })
    });
  const results = await Promise.allSettled([approve(), approve()]);
  assert.equal(executed, 1);
  const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : r.reason.code)).sort();
  assert.deepEqual(statuses, ["succeeded", "tool_unknown"]);
  assert.equal(state.audits.filter((audit) => audit.action === "AI_TOOL_EXECUTED").length, 1);
  assert.equal(state.audits.filter((audit) => audit.action === "AI_TOOL_CONFIRMATION_APPROVED").length, 1, "la aprobación perdida no se audita");

  // Una fila ya reclamada (confirmed_by) tampoco es confirmable aunque siga awaiting.
  await assert.rejects(confirmTool({ toolCallId: "call_1", ctx: context(), decision: "approve", execute: async () => ({}), ports, loadToolCall: async () => storedRow({ confirmedBy: "usr_otro" }) }), (error) => error.code === "tool_unknown");
});

test("SEC-03: una fila de la propiedad A no se confirma desde la propiedad B (404 opaco) y la ejecución corre con la propiedad de la fila", async () => {
  const { ports, state } = fakePorts();
  const row = storedRow({ toolName: "createHousekeepingTask", inputJson: { roomId: "room_of_prop_A", taskType: "stayover" } });
  await assert.rejects(confirmTool({ toolCallId: "call_1", ctx: context({ propertyId: "prop_B", enabledModules: ["housekeeping"] }), decision: "approve", execute: async () => ({ ok: true }), ports, loadToolCall: async () => row }), (error) => {
    assert.equal(error.code, "tool_unknown");
    assert.equal(error.status, 404);
    return true;
  });
  assert.equal(state.patches.length, 0);
  const seen = [];
  const ok = await confirmTool({ toolCallId: "call_1", ctx: context({ enabledModules: ["housekeeping"] }), decision: "approve", execute: async (input, ctx) => (seen.push({ input, propertyId: ctx.propertyId }), { ok: true }), ports, loadToolCall: async () => row });
  assert.equal(ok.status, "succeeded");
  assert.deepEqual(seen, [{ input: { roomId: "room_of_prop_A", taskType: "stayover" }, propertyId: "prop_test" }]);
});

test("SEC-03: la confirmación re-evalúa aiEnabled, ajuste por herramienta y presupuesto; la fila sigue pendiente", async () => {
  const off = fakePorts();
  off.state.property = { aiEnabled: false, defaultAutomationLevel: "off", monthlyBudgetEur: 0 };
  let executed = 0;
  const execute = async () => (executed += 1);
  await assert.rejects(confirmTool({ toolCallId: "call_1", ctx: context(), decision: "approve", execute, ports: off.ports, loadToolCall: async () => storedRow() }), (error) => error.code === "ai_disabled_for_property" && error.status === 403);

  const disabledTool = fakePorts();
  disabledTool.state.toolSetting = { enabled: false, automationLevel: "suggest_and_confirm", requiresConfirmation: true, requiresApprovalRole: null };
  await assert.rejects(confirmTool({ toolCallId: "call_1", ctx: context(), decision: "approve", execute, ports: disabledTool.ports, loadToolCall: async () => storedRow() }), (error) => error.code === "tool_denied" && /desactivada/.test(error.message));

  const budget = fakePorts();
  budget.state.property = { aiEnabled: true, defaultAutomationLevel: "suggest_and_confirm", monthlyBudgetEur: 1 };
  budget.state.mtdEur = 1;
  await assert.rejects(confirmTool({ toolCallId: "call_1", ctx: context(), decision: "approve", execute, ports: budget.ports, loadToolCall: async () => storedRow() }), (error) => {
    assert.equal(error.code, "budget_exceeded");
    assert.equal(error.status, 403);
    assert.equal(error.details.spentEur, 1);
    return true;
  });
  assert.equal(executed, 0);
  for (const { state } of [off, disabledTool, budget]) assert.equal(state.patches.length, 0, "la fila no cambia: se podrá confirmar cuando la puerta lo permita");

  // El rechazo no re-evalúa puertas: siempre es posible.
  const rejected = await confirmTool({ toolCallId: "call_1", ctx: context(), decision: "reject", execute, ports: off.ports, loadToolCall: async () => storedRow() });
  assert.equal(rejected.status, "rejected");
});

test("SEC-03: caducidad — una fila con más de 24 h pasa a rejected (guarda condicional), cierra la revisión y responde confirmation_expired (409)", async () => {
  const { ports, state } = fakePorts();
  const now = 1_700_000_000_000;
  const old = storedRow({ createdAt: new Date(now - CONFIRMATION_TTL_MS - 1).toISOString() });
  let executed = 0;
  await assert.rejects(confirmTool({ toolCallId: "call_1", ctx: context(), decision: "approve", execute: async () => (executed += 1), ports, loadToolCall: async () => old, now: () => now }), (error) => {
    assert.ok(error instanceof AiError);
    assert.equal(error.code, "confirmation_expired");
    assert.equal(error.status, 409);
    assert.equal(error.message, CONFIRMATION_EXPIRED_MESSAGE);
    return true;
  });
  assert.equal(executed, 0);
  assert.equal(state.patches.length, 1);
  assert.equal(state.patches[0].status, "rejected");
  assert.equal(state.patches[0].errorMessage, CONFIRMATION_EXPIRED_MESSAGE);
  assert.deepEqual(state.closed, [{ relatedEntityId: "call_1", decision: "rejected", userId: "usr_confirm", notes: CONFIRMATION_EXPIRED_MESSAGE }]);
  assert.deepEqual(state.audits.map((audit) => [audit.actorType, audit.action]), [["system", "AI_TOOL_CONFIRMATION_REJECTED"]]);

  // Dentro del plazo (o con ttlMs mayor) se confirma con normalidad; sin createdAt no hay caducidad.
  const fresh = fakePorts();
  const ok = await confirmTool({ toolCallId: "call_1", ctx: context(), decision: "approve", execute: async () => ({ ok: true }), ports: fresh.ports, loadToolCall: async () => storedRow({ createdAt: new Date(now - 60_000) }), now: () => now });
  assert.equal(ok.status, "succeeded");
  const longer = fakePorts();
  assert.equal((await confirmTool({ toolCallId: "call_1", ctx: context(), decision: "approve", execute: async () => ({ ok: true }), ports: longer.ports, loadToolCall: async () => old, now: () => now, ttlMs: 2 * CONFIRMATION_TTL_MS })).status, "succeeded");
});

test("SEC-04: requiresApprovalRole de la fila (o del ajuste por herramienta) exige ese rol en ctx.roles o ai.high_risk.confirm", async () => {
  const { ports, state } = fakePorts();
  const row = storedRow({ outputJson: { proposal: { action: "assignRoom" }, effect: "write", requiresApprovalRole: "general_manager" } });
  const basePermissions = ["pms.reservation.modify", "ai.tool.execute"];
  let executed = 0;
  const execute = async () => (executed += 1);
  await assert.rejects(confirmTool({ toolCallId: "call_1", ctx: context({ permissions: basePermissions }), decision: "approve", execute, ports, loadToolCall: async () => row }), (error) => {
    assert.equal(error.code, "tool_denied");
    assert.equal(error.status, 403);
    assert.deepEqual(error.details, { missing: ["ai.high_risk.confirm"], requiresApprovalRole: "general_manager" });
    assert.match(error.message, /aprobación del rol general_manager/);
    return true;
  });
  assert.equal(executed, 0);
  assert.equal(state.patches.length, 0);
  // El rol del confirmador satisface la aprobación sin la clave de alto riesgo…
  const byRole = await confirmTool({ toolCallId: "call_1", ctx: context({ permissions: basePermissions, roles: ["general_manager"] }), decision: "approve", execute, ports, loadToolCall: async () => ({ ...row, id: "call_2" }) });
  assert.equal(byRole.status, "succeeded");
  // …y ai.high_risk.confirm también.
  const byPermission = await confirmTool({ toolCallId: "call_3", ctx: context({ permissions: [...basePermissions, HIGH_RISK_CONFIRM_PERMISSION] }), decision: "approve", execute, ports, loadToolCall: async () => ({ ...row, id: "call_3" }) });
  assert.equal(byPermission.status, "succeeded");
  // Rol configurado por propiedad (PropertyAiToolSetting.requiresApprovalRole) con una fila sin rol persistido.
  const perTool = fakePorts();
  perTool.state.toolSetting = { enabled: true, automationLevel: "suggest_and_confirm", requiresConfirmation: true, requiresApprovalRole: "owner" };
  await assert.rejects(confirmTool({ toolCallId: "call_1", ctx: context({ permissions: basePermissions }), decision: "approve", execute, ports: perTool.ports, loadToolCall: async () => storedRow() }), (error) => error.code === "tool_denied" && error.details.requiresApprovalRole === "owner");
  assert.equal(executed, 2);
});

test("SEC-06: al cerrar la fila, inputJson y la propuesta se persisten redactados (la entrada ejecutable solo vive mientras está pendiente)", async () => {
  const { ports, state } = fakePorts();
  const body = "Hola Sra. Ludmila Ferreiro, llámenos al 612 345 678.";
  const row = storedRow({ toolName: "sendGuestMessage", inputJson: { conversationId: "conv_1", body }, outputJson: { proposal: { body }, effect: "write" } });
  const seen = [];
  const result = await confirmTool({ toolCallId: "call_1", ctx: context({ enabledModules: ["ai_concierge"] }), decision: "approve", execute: async (input) => (seen.push(input), { output: { messageId: "msg_1", body: input.body }, record: { messageId: "msg_1" } }), ports, loadToolCall: async () => row });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(seen, [{ conversationId: "conv_1", body }], "se ejecuta con la entrada real guardada");
  const closing = state.patches[1];
  assert.deepEqual(closing.inputJson, { conversationId: "conv_1", body: "Hola Sra. [NOMBRE_1], llámenos al [TEL_1]." });
  assert.deepEqual(closing.outputJson.proposal, { body: "Hola Sra. [NOMBRE_1], llámenos al [TEL_1]." });
  assert.deepEqual(closing.outputJson.execution, { messageId: "msg_1" });
  // El rechazo también redacta al cerrar.
  const rejecting = fakePorts();
  await confirmTool({ toolCallId: "call_1", ctx: context({ enabledModules: ["ai_concierge"] }), decision: "reject", execute: async () => ({}), ports: rejecting.ports, loadToolCall: async () => row });
  assert.equal(rejecting.state.patches[0].inputJson.body, "Hola Sra. [NOMBRE_1], llámenos al [TEL_1].");
});
