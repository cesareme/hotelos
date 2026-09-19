// Etiquetas en español de los códigos de error de IA. Las reutilizan el API
// (mensajes de respaldo honesto), admin-web y móvil; nunca se simula una
// respuesta: cuando no hay modelo, el texto lo dice.

import type { AiErrorCode } from "./errors.js";

export const AI_ERROR_LABELS_ES: Record<AiErrorCode, string> = Object.freeze({
  not_configured: "Sin modelo configurado",
  provider_unsupported: "Proveedor de IA no soportado",
  model_forbidden: "Modelo no permitido por la política de retención",
  budget_unavailable: "Presupuesto de IA no aplicable: falta el tipo de cambio USD→EUR (AI_USD_EUR_RATE)",
  ai_disabled_for_property: "IA desactivada en esta propiedad",
  budget_exceeded: "Presupuesto mensual de IA agotado",
  rate_limited: "Límite de peticiones de IA alcanzado",
  provider_error: "Error del proveedor de IA",
  timeout: "Tiempo de espera agotado",
  invalid_output: "Respuesta del modelo no válida",
  truncated: "Respuesta del modelo truncada por el límite de tokens",
  refusal: "El modelo rechazó la petición",
  pii_redaction_failed: "No se pudo anonimizar el texto",
  tool_unknown: "Herramienta desconocida",
  tool_not_implemented: "Herramienta sin ejecución disponible",
  tool_denied: "Herramienta no permitida",
  confirmation_expired: "Confirmación caducada",
  payload_too_large: "Documento demasiado grande"
});

export function labelFor(code: AiErrorCode): string {
  return AI_ERROR_LABELS_ES[code] ?? "Error de IA";
}
