// Tanda L6a (lote 4): scanIdDocumentCommand con ports del runner y ai-core
// falsos (sin Prisma, sin red). Sin proveedor → fila skipped y mensaje de OCR
// no configurado; error del proveedor → fila failed y mensaje de indisponibilidad;
// éxito con visión simulada → fila completed con modelo y campos; puertas del
// runner (IA apagada, presupuesto) → respuesta manual con la misma forma.
// From apps/api:
//   node --import tsx --test src/modules/ai/__tests__/scan-id-document.test.mts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { TOOL_DEFINITIONS } from "@hotelos/ai-tools";
import { HOTEL_MODULE_CODES } from "@hotelos/product";
import type { PermissionKey } from "@hotelos/shared";
import { resetAiCoreForTests } from "../../../lib/ai-client.js";
import type { UserContext } from "../../../lib/demo-store.js";
import { resetAiToolRunnerForTests, type ToolRunnerDeps } from "../../ai-operations/tool-runner.service.js";
import { SCAN_ID_RECORD_AS, SCAN_NOT_CONFIGURED_MESSAGE, SCAN_UNAVAILABLE_MESSAGE, scanIdDocumentCommand } from "../scan-id-document.command.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests del comando de escaneo");
}) as typeof fetch;

const ALL_PERMISSIONS = [...new Set(TOOL_DEFINITIONS.flatMap((definition) => definition.requiredPermissions))] as PermissionKey[];
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const CONFIGURED: NodeJS.ProcessEnv = { AI_PROVIDER: "anthropic", AI_PROVIDER_API_KEY: "sk-test-not-a-real-key", AI_USD_EUR_RATE: "0.9" };

type Captured = { url: string; body: Record<string, unknown> };

function fakeFetch(captured: Captured[], responder: (body: Record<string, unknown>) => { status?: number; json: unknown }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    captured.push({ url: String(input), body });
    const reply = responder(body);
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function anthropicText(text: string, model = "claude-sonnet-5") {
  return { id: "msg_test", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1200, output_tokens: 80 } };
}

const DOC_KEYS = ["documentType", "documentNumber", "documentSupportNumber", "firstName", "surname1", "surname2", "dateOfBirth", "nationality", "sex"] as const;

function identityJson(fields: Partial<Record<(typeof DOC_KEYS)[number], string | null>>): string {
  const data: Record<string, unknown> = {};
  const confidence: Record<string, number | null> = {};
  for (const key of DOC_KEYS) {
    data[key] = fields[key] ?? null;
    confidence[key] = fields[key] ? 0.9 : null;
  }
  data.confidence = confidence;
  return JSON.stringify(data);
}

function user(overrides: Partial<UserContext> = {}): UserContext {
  return { organizationId: "org_scan", propertyId: "prop_scan", userId: "usr_scan", fullName: "Recepción", deviceId: "dev_scan", permissions: ALL_PERMISSIONS, ...overrides };
}

type FakeState = {
  rows: Array<Record<string, unknown> & { id: string }>;
  audits: Array<Record<string, unknown>>;
  settings: { aiEnabled: boolean; defaultAutomationLevel: string; configurationJson: Record<string, unknown> };
  mtdEur: number;
};

function fakeDeps(overrides: Partial<FakeState> = {}): { deps: Partial<ToolRunnerDeps>; state: FakeState } {
  const state: FakeState = { rows: [], audits: [], settings: { aiEnabled: true, defaultAutomationLevel: "suggest_and_confirm", configurationJson: {} }, mtdEur: 0, ...overrides };
  let seq = 0;
  const deps: Partial<ToolRunnerDeps> = {
    getPropertyAiSettings: async () => state.settings,
    findToolSetting: async () => null,
    evaluatePolicyGate: async () => ({ allowed: true, requiresConfirmation: false, requiresHumanReview: false, reasons: ["No policy gate triggered; action permitted."] }),
    recordToolCall: async (input) => {
      const row = { id: `call_${++seq}`, ...input };
      state.rows.push(row);
      return { id: row.id };
    },
    updateToolCall: async () => ({ count: 1 }),
    monthToDateCostEur: async () => state.mtdEur,
    enqueueReview: async () => ({ id: "rev_never" }),
    findPendingReview: async () => null,
    approveReview: async () => undefined,
    rejectReview: async () => undefined,
    recordAuditEvent: (input) => {
      state.audits.push(input);
      return input;
    },
    getEnabledModuleCodes: () => [...HOTEL_MODULE_CODES],
    loadToolCall: async () => null,
    monthlyBudgetEurDefault: () => 25,
    now: () => 1_700_000_000_000
  };
  return { deps, state };
}

afterEach(() => {
  resetAiToolRunnerForTests();
  resetAiCoreForTests({ env: {} });
});

describe("scanIdDocumentCommand · formas del contrato y filas de telemetría", () => {
  it("sin proveedor → configured:false, source manual, mensaje de OCR no configurado y fila scan_id_document `skipped` sin coste", async () => {
    const { deps, state } = fakeDeps();
    resetAiToolRunnerForTests(deps);
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: {}, fetchImpl: fakeFetch(captured, () => ({ json: anthropicText("nunca") })) });

    const result = await scanIdDocumentCommand({ context: user(), imageDataUrl: PNG, correlationId: "corr_scan_1" });
    assert.deepEqual(result, { configured: false, fields: {}, source: "manual", message: SCAN_NOT_CONFIGURED_MESSAGE });
    assert.match(result.message, /introduzca los datos manualmente/i);
    assert.equal(captured.length, 0, "sin clave no se llama a la red");

    assert.equal(state.rows.length, 1);
    const row = state.rows[0]!;
    assert.equal(row.toolName, SCAN_ID_RECORD_AS);
    assert.equal(row.status, "skipped");
    assert.equal(row.propertyId, "prop_scan");
    assert.equal(row.userId, "usr_scan");
    assert.deepEqual(row.inputJson, { hasImage: true });
    assert.equal(row.model, undefined);
    assert.equal(row.costEur, 0);
    assert.equal(row.errorMessage, "not_configured");
    assert.equal(state.audits[0]!.actorType, "ai");
    assert.equal(state.audits[0]!.action, "AI_TOOL_EXECUTED");
  });

  it("error del proveedor (400 no reintentable) → mensaje de indisponibilidad y fila `failed`", async () => {
    const { deps, state } = fakeDeps();
    resetAiToolRunnerForTests(deps);
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED, fetchImpl: fakeFetch(captured, () => ({ status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "imagen no admitida" } } })) });

    const result = await scanIdDocumentCommand({ context: user(), imageDataUrl: PNG, correlationId: "corr_scan_2" });
    assert.deepEqual(result, { configured: false, fields: {}, source: "manual", message: SCAN_UNAVAILABLE_MESSAGE });
    assert.equal(captured.length, 1, "una sola petición: 400 no se reintenta");
    assert.equal(state.rows[0]!.status, "failed");
    assert.match(String(state.rows[0]!.errorMessage), /^provider_error:/);
    assert.equal(state.audits[0]!.action, "AI_TOOL_FAILED");
  });

  it("imagen que no es una URL de datos → fila `failed` (invalid_output) y respuesta manual", async () => {
    const { deps, state } = fakeDeps();
    resetAiToolRunnerForTests(deps);
    const captured: Captured[] = [];
    resetAiCoreForTests({ env: CONFIGURED, fetchImpl: fakeFetch(captured, () => ({ json: anthropicText("nunca") })) });

    const result = await scanIdDocumentCommand({ context: user(), imageDataUrl: "no-es-una-imagen", correlationId: "corr_scan_3" });
    assert.equal(result.configured, false);
    assert.equal(result.source, "manual");
    assert.equal(result.message, SCAN_UNAVAILABLE_MESSAGE);
    assert.equal(captured.length, 0);
    assert.equal(state.rows[0]!.status, "failed");
    assert.match(String(state.rows[0]!.errorMessage), /^invalid_output:/);
  });

  it("éxito con visión simulada → configured:true, fields, source ai; fila `completed` con modelo, tokens y coste; sin valores del documento en la fila", async () => {
    const { deps, state } = fakeDeps();
    resetAiToolRunnerForTests(deps);
    const captured: Captured[] = [];
    resetAiCoreForTests({
      env: CONFIGURED,
      fetchImpl: fakeFetch(captured, () => ({ json: anthropicText(identityJson({ documentType: "DNI", documentNumber: "12345678Z", firstName: "Prueba", surname1: "Ensayo", dateOfBirth: "1990-01-01", nationality: "ESP", sex: "F" })) }))
    });

    const result = await scanIdDocumentCommand({ context: user(), imageDataUrl: PNG, correlationId: "corr_scan_4" });
    assert.equal(result.configured, true);
    if (!result.configured) return;
    assert.equal(result.source, "ai");
    assert.deepEqual(result.fields, { documentType: "DNI", documentNumber: "12345678Z", firstName: "Prueba", surname1: "Ensayo", dateOfBirth: "1990-01-01", nationality: "ESP", sex: "F" });
    assert.equal(Object.keys(result).sort().join(","), "configured,fields,source", "misma forma que el handler: sin claves extra");

    assert.equal(captured.length, 1);
    const sent = captured[0]!.body;
    assert.equal(sent.model, "claude-sonnet-5");
    assert.ok(JSON.stringify(sent).includes('"type":"image"'), "la imagen viaja como bloque image");
    assert.ok((sent.output_config as { format?: { type?: string } } | undefined)?.format?.type === "json_schema", "salida estructurada");

    const row = state.rows[0]!;
    assert.equal(row.toolName, SCAN_ID_RECORD_AS);
    assert.equal(row.status, "completed");
    assert.equal(row.model, "claude-sonnet-5");
    assert.equal(row.tokensInput, 1200);
    assert.equal(row.tokensOutput, 80);
    // sonnet-5: 1200 × 2 $/M + 80 × 10 $/M = 0,0032 $ → × 0,9 = 0,00288 €
    assert.equal(row.costEur, 0.00288);
    const serialized = JSON.stringify(row.outputJson);
    assert.ok(!serialized.includes("12345678Z") && !serialized.includes("Prueba"), "la fila no guarda los valores del documento");
    assert.ok(serialized.includes("fieldsRead"));
    assert.equal(state.audits[0]!.action, "AI_TOOL_EXECUTED");
    assert.equal(state.audits[0]!.actorType, "ai");
  });

  it("IA desactivada en la propiedad → respuesta manual con el motivo y fila `rejected`; presupuesto agotado → manual (403 capturado)", async () => {
    const off = fakeDeps({ settings: { aiEnabled: false, defaultAutomationLevel: "suggest_and_confirm", configurationJson: {} } });
    resetAiToolRunnerForTests(off.deps);
    resetAiCoreForTests({ env: CONFIGURED, fetchImpl: fakeFetch([], () => ({ json: anthropicText("nunca") })) });
    const disabled = await scanIdDocumentCommand({ context: user(), imageDataUrl: PNG, correlationId: "corr_scan_5" });
    assert.equal(disabled.configured, false);
    assert.match(disabled.message, /IA desactivada en esta propiedad; introduzca los datos manualmente\./);
    assert.equal(off.state.rows[0]!.status, "rejected");
    assert.equal(off.state.rows[0]!.errorMessage, "ai_disabled_for_property");
    assert.equal(off.state.audits[0]!.action, "AI_TOOL_DENIED");

    const exhausted = fakeDeps({ settings: { aiEnabled: true, defaultAutomationLevel: "suggest_and_confirm", configurationJson: { monthlyBudgetEur: 0.01 } }, mtdEur: 0.02 });
    resetAiToolRunnerForTests(exhausted.deps);
    const budget = await scanIdDocumentCommand({ context: user(), imageDataUrl: PNG, correlationId: "corr_scan_6" });
    assert.equal(budget.configured, false);
    assert.equal(budget.source, "manual");
    assert.match(budget.message, /Presupuesto mensual de IA agotado; introduzca los datos manualmente\./);
    assert.equal(exhausted.state.rows[0]!.status, "rejected");
    assert.equal(exhausted.state.rows[0]!.errorMessage, "budget_exceeded");
  });
});
