// Tanda L6a (lote 3): tool runner del API con dependencias inyectadas (sin
// Prisma, sin red). buildRunnerPorts sobre fakes, runAiTool con los errores
// tipados (403 AI_BUDGET_EXCEEDED, 429 AI_RATE_LIMITED) y confirmToolCall.
// From apps/api:
//   node --import tsx --test src/modules/ai-operations/__tests__/tool-runner.test.mts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AiError } from "@hotelos/ai-core";
import { TOOL_DEFINITIONS } from "@hotelos/ai-tools";
import { HOTEL_MODULE_CODES } from "@hotelos/product";
import type { PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, TooManyRequestsError } from "../../../lib/http-error.js";
import { buildRunnerPorts, confirmToolCall, isReviewAlreadyDecided, resetAiToolRunnerForTests, runAiTool, type ToolRunnerDeps } from "../tool-runner.service.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests del tool runner");
}) as typeof fetch;

const ALL_PERMISSIONS = [...new Set(TOOL_DEFINITIONS.flatMap((definition) => definition.requiredPermissions))] as PermissionKey[];

function user(overrides: Partial<UserContext> = {}): UserContext {
  return { organizationId: "org_runner", propertyId: "prop_runner", userId: "usr_runner", fullName: "Recepción", deviceId: "dev_1", permissions: ALL_PERMISSIONS, ...overrides };
}

type FakeState = {
  rows: Array<Record<string, unknown> & { id: string }>;
  patches: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  rejections: Array<Record<string, unknown>>;
  settings: { aiEnabled: boolean; defaultAutomationLevel: string; configurationJson: Record<string, unknown> };
  mtdEur: number;
  pendingReview: { id: string } | null;
  storedRow: Record<string, unknown> | null;
};

function fakeDeps(overrides: Partial<FakeState> = {}): { deps: Partial<ToolRunnerDeps>; state: FakeState } {
  const state: FakeState = {
    rows: [],
    patches: [],
    audits: [],
    reviews: [],
    approvals: [],
    rejections: [],
    settings: { aiEnabled: true, defaultAutomationLevel: "suggest_and_confirm", configurationJson: {} },
    mtdEur: 0,
    pendingReview: null,
    storedRow: null,
    ...overrides
  };
  let seq = 0;
  /** Simula la guarda condicional del API (SEC-02): la primera escritura con guard.unclaimed reclama la fila. */
  const claimed = new Set<string>();
  const deps: Partial<ToolRunnerDeps> = {
    getPropertyAiSettings: async () => state.settings,
    findToolSetting: async () => null,
    evaluatePolicyGate: async () => ({ allowed: true, requiresConfirmation: false, requiresHumanReview: false, reasons: ["No policy gate triggered; action permitted."] }),
    recordToolCall: async (input) => {
      const row = { id: `call_${++seq}`, ...input };
      state.rows.push(row);
      return { id: row.id };
    },
    updateToolCall: async (id, patch, guard) => {
      if (guard?.unclaimed) {
        if (claimed.has(id)) return { count: 0 };
        claimed.add(id);
      }
      state.patches.push({ id, ...patch });
      return { count: 1 };
    },
    monthToDateCostEur: async () => state.mtdEur,
    enqueueReview: async (input) => {
      state.reviews.push(input);
      return { id: `rev_${state.reviews.length}` };
    },
    findPendingReview: async () => state.pendingReview,
    approveReview: async (input) => {
      state.approvals.push(input);
      if (state.approvals.length > 1) throw new ConflictError('No se puede aprobar un elemento de revisión en estado "approved".');
    },
    rejectReview: async (input) => {
      state.rejections.push(input);
    },
    recordAuditEvent: (input) => {
      state.audits.push(input);
      return input;
    },
    getEnabledModuleCodes: () => [...HOTEL_MODULE_CODES],
    loadToolCall: async (id) => (state.storedRow && state.storedRow.id === id ? (state.storedRow as never) : null),
    monthlyBudgetEurDefault: () => 25,
    now: () => 1_700_000_000_000
  };
  return { deps, state };
}

afterEach(() => resetAiToolRunnerForTests());

describe("buildRunnerPorts · ports del API sobre dependencias inyectadas", () => {
  it("getPropertySetting lee aiEnabled/nivel y el presupuesto de configurationJson (defecto AI_MONTHLY_BUDGET_EUR_DEFAULT)", async () => {
    const { deps } = fakeDeps({ settings: { aiEnabled: false, defaultAutomationLevel: "autonomous", configurationJson: { monthlyBudgetEur: 40 } } });
    const ports = buildRunnerPorts(deps);
    assert.deepEqual(await ports.getPropertySetting("prop_runner"), { aiEnabled: false, defaultAutomationLevel: "autonomous", monthlyBudgetEur: 40 });
    const byDefault = buildRunnerPorts({ ...deps, getPropertyAiSettings: async () => ({ aiEnabled: true, defaultAutomationLevel: "suggest", configurationJson: {} }) });
    assert.equal((await byDefault.getPropertySetting("prop_runner")).monthlyBudgetEur, 25);
    assert.equal(ports.getDefinition("assignRoom")?.effect, "write");
    assert.equal(ports.getDefinition("nope"), null);
    assert.deepEqual(ports.canExecute({ toolName: "getHousekeepingBoard", enabledModules: ["pms_core"], userPermissions: ALL_PERMISSIONS }), { allowed: false, reason: "Module housekeeping is disabled." });
  });

  it("closeReview aprueba/rechaza la revisión pendiente y tolera ConflictError («ya decidida»)", async () => {
    const { deps, state } = fakeDeps({ pendingReview: { id: "rev_9" } });
    const ports = buildRunnerPorts(deps, { user: user(), correlationId: "corr_x" });
    await ports.closeReview("call_1", "approved", "usr_runner", "ok");
    assert.equal(state.approvals.length, 1);
    assert.equal((state.approvals[0] as { id: string }).id, "rev_9");
    assert.equal((state.approvals[0] as { correlationId: string }).correlationId, "corr_x");
    // Segunda aprobación: el fake lanza ConflictError y el port lo tolera.
    await ports.closeReview("call_1", "approved", "usr_runner");
    assert.equal(state.approvals.length, 2);
    await ports.closeReview("call_1", "rejected", "usr_runner", "  ");
    assert.equal((state.rejections[0] as { reason: string }).reason, "Rechazada desde la confirmación de la herramienta de IA.");
    // Sin revisión pendiente: no llama a nada.
    const none = buildRunnerPorts({ ...deps, findPendingReview: async () => null }, { user: user() });
    await none.closeReview("call_2", "approved", "usr_runner");
    assert.equal(state.approvals.length, 2);
    assert.equal(isReviewAlreadyDecided(new ConflictError("x")), true);
    assert.equal(isReviewAlreadyDecided(new Error("Cannot approve a review item with status approved")), true);
    assert.equal(isReviewAlreadyDecided(new Error("DB down")), false);
    await assert.rejects(buildRunnerPorts({ ...deps, approveReview: async () => { throw new Error("DB down"); } }, { user: user() }).closeReview("call_1", "approved", "usr_runner"), /DB down/);
  });
});

describe("runAiTool · ejecución, confirmación y errores tipados", () => {
  it("lectura con execute inyectado → executed con fila succeeded, audit actorType ai y módulos del contexto", async () => {
    const { deps, state } = fakeDeps();
    resetAiToolRunnerForTests(deps);
    const result = await runAiTool({ context: user(), toolName: "findReservation", input: { code: "RES-1" }, execute: async (input) => ({ reservation: { code: (input as { code: string }).code } }), correlationId: "corr_1" });
    assert.equal(result.status, "executed");
    assert.equal(state.rows[0]!.status, "succeeded");
    assert.equal(state.rows[0]!.toolName, "findReservation");
    assert.equal(state.rows[0]!.propertyId, "prop_runner");
    assert.equal(state.rows[0]!.costEur, 0);
    assert.equal(state.audits[0]!.actorType, "ai");
    assert.equal(state.audits[0]!.action, "AI_TOOL_EXECUTED");
    assert.equal(state.audits[0]!.correlationId, "corr_1");
  });

  it("escritura con la implementación del catálogo → awaiting_confirmation con la tarjeta del preview y entrada validada (400 si no cumple)", async () => {
    const { deps, state } = fakeDeps();
    resetAiToolRunnerForTests(deps);
    const result = await runAiTool({ context: user(), toolName: "assignRoom", input: { reservationId: "res_1", roomId: "room_1" }, correlationId: "corr_2" });
    assert.equal(result.status, "awaiting_confirmation");
    assert.deepEqual(result.status === "awaiting_confirmation" ? result.preview : null, { action: "assignRoom", reservationId: "res_1", roomId: "room_1" });
    assert.equal(state.rows[0]!.status, "awaiting_confirmation");
    assert.equal(state.rows[0]!.requiredConfirmation, true);
    assert.equal(state.audits[0]!.action, "AI_TOOL_CONFIRMATION_REQUESTED");

    await assert.rejects(runAiTool({ context: user(), toolName: "assignRoom", input: { reservationId: "res_1" }, correlationId: "corr_3" }), (error: unknown) => {
      assert.ok(error instanceof BadRequestError);
      assert.match((error as Error).message, /Entrada no válida para la herramienta assignRoom/);
      return true;
    });
    assert.equal(state.rows.length, 1, "una entrada inválida no registra nada");
  });

  it("herramienta sin implementación (dinero/fiscal) → denied tool_not_implemented registrado como rejected", async () => {
    const { deps, state } = fakeDeps();
    resetAiToolRunnerForTests(deps);
    const result = await runAiTool({ context: user(), toolName: "postFolioCharge", input: { folioId: "f1" }, correlationId: "corr_4" });
    assert.equal(result.status, "denied");
    assert.equal(result.status === "denied" ? result.reason : null, "tool_not_implemented");
    assert.equal(state.rows[0]!.status, "rejected");
    assert.equal(state.audits[0]!.action, "AI_TOOL_DENIED");
  });

  it("budget_exceeded → ForbiddenError 403 con details.code AI_BUDGET_EXCEEDED, presupuesto y gasto", async () => {
    const { deps, state } = fakeDeps({ settings: { aiEnabled: true, defaultAutomationLevel: "suggest", configurationJson: { monthlyBudgetEur: 25 } }, mtdEur: 25 });
    resetAiToolRunnerForTests(deps);
    let executed = 0;
    await assert.rejects(runAiTool({ context: user(), toolName: "findReservation", input: { code: "RES-1" }, execute: async () => (executed += 1), correlationId: "corr_5" }), (error: unknown) => {
      assert.ok(error instanceof ForbiddenError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.message, "Presupuesto mensual de IA agotado.");
      assert.deepEqual(error.details, { code: "AI_BUDGET_EXCEEDED", propertyId: "prop_runner", budgetEur: 25, spentEur: 25, toolCallId: "call_1" });
      return true;
    });
    assert.equal(executed, 0);
    assert.equal(state.rows[0]!.status, "rejected");
    assert.equal(state.rows[0]!.errorMessage, "budget_exceeded");
  });

  it("rate_limited (AiError de ai-core dentro del execute) → TooManyRequestsError 429 con retryAfterSeconds y fila failed", async () => {
    const { deps, state } = fakeDeps();
    resetAiToolRunnerForTests(deps);
    await assert.rejects(
      runAiTool({
        context: user(),
        toolName: "analyzeReviewSentiment",
        input: { text: "Muy bien" },
        execute: async () => {
          throw new AiError("rate_limited", "Límite de peticiones de IA alcanzado para la organización; reintente en 2 s.", { retryable: true, status: 429, retryAfterMs: 1500 });
        },
        correlationId: "corr_6"
      }),
      (error: unknown) => {
        assert.ok(error instanceof TooManyRequestsError);
        assert.equal(error.statusCode, 429);
        assert.deepEqual(error.details, { code: "AI_RATE_LIMITED", retryAfterSeconds: 2 });
        return true;
      }
    );
    assert.equal(state.rows[0]!.status, "failed");
    assert.match(String(state.rows[0]!.errorMessage), /^rate_limited: /);
    assert.equal(state.audits[0]!.action, "AI_TOOL_FAILED");
  });

  it("otras denegaciones (IA apagada, módulo, permiso) se devuelven tipadas sin lanzar", async () => {
    const { deps } = fakeDeps({ settings: { aiEnabled: false, defaultAutomationLevel: "suggest", configurationJson: {} } });
    resetAiToolRunnerForTests(deps);
    const off = await runAiTool({ context: user(), toolName: "findReservation", input: { code: "x" }, execute: async () => ({}), correlationId: "corr_7" });
    assert.equal(off.status, "denied");
    assert.equal(off.status === "denied" ? off.reason : null, "ai_disabled_for_property");

    const noPermission = fakeDeps();
    resetAiToolRunnerForTests(noPermission.deps);
    const missing = await runAiTool({ context: user({ permissions: ["ai.tool.execute"] }), toolName: "getHousekeepingBoard", input: {}, execute: async () => [], correlationId: "corr_8" });
    assert.equal(missing.status === "denied" ? missing.reason : null, "missing_permission");
  });

  it("alias legado y vocabulario legado: scan_id_document se persiste con ese nombre y status skipped sin modelo", async () => {
    const { deps, state } = fakeDeps();
    resetAiToolRunnerForTests(deps);
    const result = await runAiTool({
      context: user(),
      toolName: "scan_id_document",
      recordAs: "scan_id_document",
      legacyStatus: { succeeded: "completed", notConfigured: "skipped" },
      input: { hasImage: true },
      execute: async () => ({ configured: false, reason: "not_configured", message: "Sin modelo configurado" }),
      correlationId: "corr_9"
    });
    assert.equal(result.status, "executed");
    assert.equal(result.status === "executed" ? result.configured : null, false);
    assert.equal(state.rows[0]!.toolName, "scan_id_document");
    assert.equal(state.rows[0]!.status, "skipped");
    assert.equal(state.rows[0]!.tokensInput, 0);
    assert.equal(state.rows[0]!.costEur, 0);
  });
});

describe("confirmToolCall · decisión humana sobre una fila awaiting_confirmation", () => {
  const stored = (overrides: Record<string, unknown> = {}) => ({
    id: "call_7",
    organizationId: "org_runner",
    propertyId: "prop_runner",
    userId: "usr_runner",
    conversationId: null,
    toolName: "assignRoom",
    status: "awaiting_confirmation",
    inputJson: { reservationId: "res_1", roomId: "room_1" },
    outputJson: { proposal: { action: "assignRoom" } },
    requiredConfirmation: true,
    automationLevel: "suggest_and_confirm",
    ...overrides
  });

  it("approve ejecuta con el inputJson guardado, cierra la revisión (approved) y audita user + ai", async () => {
    const { deps, state } = fakeDeps({ pendingReview: { id: "rev_1" } });
    state.storedRow = stored();
    resetAiToolRunnerForTests(deps);
    const seen: unknown[] = [];
    const result = await confirmToolCall({
      context: user(),
      toolCallId: "call_7",
      decision: "approve",
      notes: "Revisado",
      correlationId: "corr_c1",
      execute: async (input) => {
        seen.push(input);
        return { assigned: true };
      }
    });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(seen, [{ reservationId: "res_1", roomId: "room_1" }]);
    assert.equal(state.patches.length, 2, "reclamación condicional + cierre");
    assert.equal(state.patches[0]!.confirmedBy, "usr_runner");
    assert.equal(state.patches[1]!.status, "succeeded");
    assert.equal(state.patches[1]!.confirmedBy, "usr_runner");
    assert.equal(state.approvals.length, 1);
    assert.equal((state.approvals[0] as { notes: string }).notes, "Revisado");
    assert.deepEqual(state.audits.map((audit) => [audit.actorType, audit.action]), [
      ["user", "AI_TOOL_CONFIRMATION_APPROVED"],
      ["ai", "AI_TOOL_EXECUTED"]
    ]);
  });

  it("reject → rejected con closeReview rejected", async () => {
    const { deps, state } = fakeDeps({ pendingReview: { id: "rev_1" } });
    state.storedRow = stored();
    resetAiToolRunnerForTests(deps);
    const result = await confirmToolCall({ context: user(), toolCallId: "call_7", decision: "reject", notes: "No procede", correlationId: "corr_c2", execute: async () => ({}) });
    assert.equal(result.status, "rejected");
    assert.equal(state.patches[0]!.status, "rejected");
    assert.equal((state.rejections[0] as { reason: string }).reason, "No procede");
  });

  it("fila inexistente, de otra organización o no awaiting → NotFoundError 404 opaco", async () => {
    const { deps, state } = fakeDeps();
    resetAiToolRunnerForTests(deps);
    for (const row of [null, stored({ organizationId: "org_other" }), stored({ status: "succeeded" })]) {
      state.storedRow = row;
      await assert.rejects(confirmToolCall({ context: user(), toolCallId: "call_7", decision: "approve", correlationId: "corr_c3", execute: async () => ({}) }), (error: unknown) => {
        assert.ok(error instanceof NotFoundError);
        assert.equal((error as Error).message, "Llamada de herramienta no encontrada.");
        return true;
      });
    }
    assert.equal(state.patches.length, 0);
  });

  it("high/critical sin ai.high_risk.confirm → ForbiddenError con los permisos que faltan", async () => {
    const { deps, state } = fakeDeps();
    state.storedRow = stored({ toolName: "blockRoomForMaintenance", inputJson: { workOrderId: "wo_1" } });
    resetAiToolRunnerForTests(deps);
    const withoutHighRisk = ALL_PERMISSIONS.filter((permission) => permission !== "ai.high_risk.confirm");
    await assert.rejects(confirmToolCall({ context: user({ permissions: withoutHighRisk }), toolCallId: "call_7", decision: "approve", correlationId: "corr_c4", execute: async () => ({}) }), (error: unknown) => {
      assert.ok(error instanceof ForbiddenError);
      assert.deepEqual(error.details, { code: "AI_TOOL_CONFIRM_FORBIDDEN", missing: ["ai.high_risk.confirm"] });
      return true;
    });
    assert.equal(state.patches.length, 0);
  });

  it("sin implementación ni execute → failed tool_not_implemented (honesto) tras la aprobación", async () => {
    const { deps, state } = fakeDeps();
    state.storedRow = stored({ toolName: "postFolioCharge", inputJson: { folioId: "f1" } });
    resetAiToolRunnerForTests(deps);
    const result = await confirmToolCall({ context: user(), toolCallId: "call_7", decision: "approve", correlationId: "corr_c5" });
    assert.equal(result.status, "failed");
    assert.equal(result.status === "failed" ? result.reason : null, "tool_not_implemented");
    assert.equal(state.patches[1]!.status, "failed");
  });

  it("corrección 1 · SEC-03: fila de otra propiedad de la misma organización → 404 opaco; caducada → 409 AI_CONFIRMATION_EXPIRED con la fila rejected", async () => {
    const { deps, state } = fakeDeps();
    state.storedRow = stored({ propertyId: "prop_other" });
    resetAiToolRunnerForTests(deps);
    await assert.rejects(confirmToolCall({ context: user(), toolCallId: "call_7", decision: "approve", correlationId: "corr_c6", execute: async () => ({}) }), (error: unknown) => error instanceof NotFoundError);
    assert.equal(state.patches.length, 0);

    state.storedRow = stored({ createdAt: new Date(1_700_000_000_000 - 25 * 60 * 60 * 1000) });
    await assert.rejects(confirmToolCall({ context: user(), toolCallId: "call_7", decision: "approve", correlationId: "corr_c7", execute: async () => ({}) }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal((error.details as { code: string }).code, "AI_CONFIRMATION_EXPIRED");
      return true;
    });
    assert.equal(state.patches[0]!.status, "rejected");
    assert.deepEqual(state.audits.map((audit) => [audit.actorType, audit.action]), [["system", "AI_TOOL_CONFIRMATION_REJECTED"]]);
  });

  it("corrección 1 · SEC-03: al confirmar se re-evalúan aiEnabled (403 AI_DISABLED_FOR_PROPERTY) y presupuesto (403 AI_BUDGET_EXCEEDED) sin tocar la fila", async () => {
    const off = fakeDeps({ settings: { aiEnabled: false, defaultAutomationLevel: "suggest_and_confirm", configurationJson: {} } });
    off.state.storedRow = stored();
    resetAiToolRunnerForTests(off.deps);
    await assert.rejects(confirmToolCall({ context: user(), toolCallId: "call_7", decision: "approve", correlationId: "corr_c8", execute: async () => ({}) }), (error: unknown) => {
      assert.ok(error instanceof ForbiddenError);
      assert.equal((error.details as { code: string }).code, "AI_DISABLED_FOR_PROPERTY");
      return true;
    });
    assert.equal(off.state.patches.length, 0);

    const budget = fakeDeps({ settings: { aiEnabled: true, defaultAutomationLevel: "suggest_and_confirm", configurationJson: { monthlyBudgetEur: 0.01 } }, mtdEur: 0.02 });
    budget.state.storedRow = stored();
    resetAiToolRunnerForTests(budget.deps);
    await assert.rejects(confirmToolCall({ context: user(), toolCallId: "call_7", decision: "approve", correlationId: "corr_c9", execute: async () => ({}) }), (error: unknown) => {
      assert.ok(error instanceof ForbiddenError);
      const details = error.details as { code: string; budgetEur: number; spentEur: number; toolCallId: string };
      assert.equal(details.code, "AI_BUDGET_EXCEEDED");
      assert.equal(details.budgetEur, 0.01);
      assert.equal(details.spentEur, 0.02);
      assert.equal(details.toolCallId, "call_7");
      return true;
    });
    assert.equal(budget.state.patches.length, 0);
  });
});
