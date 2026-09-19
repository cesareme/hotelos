// Etiquetas en español de todos los códigos de error y utilidades de AiError.
//
// Run from the package directory: corepack pnpm --filter @hotelos/ai-core test

import { test } from "node:test";
import assert from "node:assert/strict";

import { AI_ERROR_CODES, AiError, httpStatusForAiError, isAiError } from "../errors.ts";
import { AI_ERROR_LABELS_ES, labelFor } from "../labels.ts";

globalThis.fetch = () => {
  throw new Error("red prohibida");
};

test("todos los AiErrorCode tienen etiqueta en español", () => {
  assert.equal(AI_ERROR_CODES.length, 18);
  for (const code of AI_ERROR_CODES) {
    const label = AI_ERROR_LABELS_ES[code];
    assert.equal(typeof label, "string", code);
    assert.ok(label.length > 5, code);
    assert.equal(labelFor(code), label);
    assert.notEqual(label, "Error de IA", code);
  }
  assert.equal(Object.keys(AI_ERROR_LABELS_ES).length, AI_ERROR_CODES.length);
  assert.equal(labelFor("not_configured"), "Sin modelo configurado");
  assert.equal(labelFor("provider_unsupported"), "Proveedor de IA no soportado");
  assert.equal(labelFor("model_forbidden"), "Modelo no permitido por la política de retención");
  assert.equal(labelFor("ai_disabled_for_property"), "IA desactivada en esta propiedad");
  assert.equal(labelFor("budget_exceeded"), "Presupuesto mensual de IA agotado");
  assert.equal(labelFor("rate_limited"), "Límite de peticiones de IA alcanzado");
  assert.equal(labelFor("provider_error"), "Error del proveedor de IA");
  assert.equal(labelFor("timeout"), "Tiempo de espera agotado");
  assert.equal(labelFor("invalid_output"), "Respuesta del modelo no válida");
  assert.equal(labelFor("refusal"), "El modelo rechazó la petición");
  assert.equal(labelFor("pii_redaction_failed"), "No se pudo anonimizar el texto");
  assert.equal(labelFor("tool_unknown"), "Herramienta desconocida");
  assert.equal(labelFor("tool_not_implemented"), "Herramienta sin ejecución disponible");
  assert.equal(labelFor("tool_denied"), "Herramienta no permitida");
  assert.equal(labelFor("payload_too_large"), "Documento demasiado grande");
  // Corrección 1: presupuesto inaplicable sin tipo de cambio, respuesta truncada y confirmación caducada.
  assert.equal(labelFor("budget_unavailable"), "Presupuesto de IA no aplicable: falta el tipo de cambio USD→EUR (AI_USD_EUR_RATE)");
  assert.equal(labelFor("truncated"), "Respuesta del modelo truncada por el límite de tokens");
  assert.equal(labelFor("confirmation_expired"), "Confirmación caducada");
});

test("AiError: campos tipados, toJSON sin cause, isAiError y códigos HTTP sugeridos", () => {
  const cause = new Error("raíz");
  const error = new AiError("rate_limited", "Límite", { retryable: true, status: 429, providerType: "rate_limit_error", retryAfterMs: 1500, details: { x: 1 }, cause });
  assert.equal(error.name, "AiError");
  assert.equal(error.code, "rate_limited");
  assert.equal(error.retryable, true);
  assert.equal(error.status, 429);
  assert.equal(error.providerType, "rate_limit_error");
  assert.equal(error.retryAfterMs, 1500);
  assert.deepEqual(error.details, { x: 1 });
  assert.equal(error.cause, cause);
  assert.deepEqual(error.toJSON(), { code: "rate_limited", message: "Límite", retryable: true, status: 429, providerType: "rate_limit_error", retryAfterMs: 1500 });
  assert.equal(new AiError("timeout", "t").retryable, false);
  assert.equal(isAiError(error), true);
  assert.equal(isAiError(new Error("x")), false);
  assert.equal(httpStatusForAiError("rate_limited"), 429);
  assert.equal(httpStatusForAiError("budget_exceeded"), 403);
  assert.equal(httpStatusForAiError("payload_too_large"), 413);
  assert.equal(httpStatusForAiError("not_configured"), 503);
  assert.equal(httpStatusForAiError("budget_unavailable"), 503);
  assert.equal(httpStatusForAiError("truncated"), 422);
  assert.equal(httpStatusForAiError("confirmation_expired"), 409);
  const billed = new AiError("invalid_output", "JSON inválido", { telemetry: { model: "claude-sonnet-5", tokensInput: 1200, tokensOutput: 150, cacheReadTokens: 0, costUsd: 0.0039, costEur: 0.00351, latencyMs: 40 } });
  assert.equal(billed.telemetry.costEur, 0.00351, "CFC-02: el error conserva la telemetría de la respuesta facturada");
  assert.equal("telemetry" in billed.toJSON(), false);
});
