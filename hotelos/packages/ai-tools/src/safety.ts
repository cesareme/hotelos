import type { PermissionKey, RiskLevel } from "@hotelos/shared";
import { getRiskEntry, RISK_MATRIX } from "@hotelos/compliance";
import type { ToolDefinition } from "./registry.js";
import type { HotelOsToolName } from "./tool-names.js";

export type AiSafetyFacts = {
  storesIdImage?: boolean;
  guestRegisterMissingFields?: string[];
  roomBlocked?: boolean;
  taxConfigValid?: boolean;
  priceCameFromAvailabilityTool?: boolean;
  cancellationOverridesPenalty?: boolean;
  amount?: number;
};

export type AiSafetyDecision = {
  allowed: boolean;
  actionKey: string;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  requiredApproval?: string;
  reason?: string;
};

export function evaluateAiSafety(input: {
  actionKey: string;
  permissions: PermissionKey[];
  facts?: AiSafetyFacts;
}): AiSafetyDecision {
  const facts = input.facts ?? {};

  if (facts.storesIdImage) {
    return deny(input.actionKey, "critical", "ID document images must be discarded after extraction.");
  }

  if (input.actionKey === "check_in_guest" && (facts.guestRegisterMissingFields?.length ?? 0) > 0) {
    return deny(input.actionKey, "high", `Missing guest register fields: ${facts.guestRegisterMissingFields?.join(", ")}.`);
  }

  if (input.actionKey === "assign_room" && facts.roomBlocked) {
    return deny(input.actionKey, "high", "Blocked rooms cannot be assigned.");
  }

  if (input.actionKey === "issue_invoice" && facts.taxConfigValid === false) {
    return deny(input.actionKey, "critical", "Invoice cannot be issued with invalid tax configuration.");
  }

  if (input.actionKey === "quote_availability" && facts.priceCameFromAvailabilityTool === false) {
    return deny(input.actionKey, "critical", "Booking AI may only quote prices returned by the availability tool.");
  }

  const entry = getRiskEntry(input.actionKey);
  const missingPermissions = entry.requiredPermissions.filter((permission) => !input.permissions.includes(permission));
  if (missingPermissions.length > 0) {
    return deny(input.actionKey, entry.riskLevel, `Missing permissions: ${missingPermissions.join(", ")}.`);
  }

  if (input.actionKey === "refund_payment" && (facts.amount ?? 0) >= 1000) {
    return {
      allowed: false,
      actionKey: input.actionKey,
      riskLevel: "critical",
      requiresConfirmation: false,
      requiredApproval: "manager",
      reason: "High-value refunds require manager approval."
    };
  }

  if (input.actionKey === "cancel_booking" && facts.cancellationOverridesPenalty) {
    return {
      allowed: false,
      actionKey: input.actionKey,
      riskLevel: "high",
      requiresConfirmation: true,
      requiredApproval: "manager",
      reason: "Penalty overrides require manager approval."
    };
  }

  return {
    allowed: entry.aiMayAutoExecute,
    actionKey: input.actionKey,
    riskLevel: entry.riskLevel,
    requiresConfirmation: entry.requiresConfirmation,
    requiredApproval: entry.requiredApproval,
    reason: entry.aiMayAutoExecute ? undefined : "Action must be confirmed or approved before execution."
  };
}

function deny(actionKey: string, riskLevel: RiskLevel, reason: string): AiSafetyDecision {
  return {
    allowed: false,
    actionKey,
    riskLevel,
    requiresConfirmation: false,
    reason
  };
}

// ---------------------------------------------------------------------------
// Tanda L6a (lote 3): puente entre los nombres camelCase del registro y las
// claves snake_case de packages/compliance/src/risk-matrix.ts. El tool runner
// (@hotelos/ai-core/runner) llama a evaluateAiSafetyForTool en toda ejecución;
// esta función nunca lanza (getRiskEntry sí lo hace con claves desconocidas).
// ---------------------------------------------------------------------------

/** Nombre del registro → clave de la matriz de riesgo (solo las herramientas con clave). */
export const TOOL_RISK_KEYS: Partial<Record<HotelOsToolName, string>> = Object.freeze({
  checkInReservation: "check_in_guest",
  assignRoom: "assign_room",
  createWorkOrder: "create_maintenance_task",
  quoteAvailability: "quote_availability",
  cancelReservation: "cancel_booking",
  issueInvoice: "issue_invoice",
  createJournalEntryDraft: "post_accounting_entry",
  createCapexProject: "approve_capex",
  createHousekeepingTask: "create_housekeeping_task",
  markRoomClean: "mark_room_clean",
  blockRoomForMaintenance: "block_room_for_maintenance",
  sendGuestMessage: "send_guest_message",
  answerGuestQuestion: "answer_guest_question",
  draftReviewResponse: "draft_review_response",
  analyzeReviewSentiment: "analyze_review_sentiment",
  extractGuestIdentityFieldsTemporary: "extract_identity_document",
  classifyIncomingDocument: "classify_document",
  extractIncomingDocumentFields: "extract_document_fields",
  prepareGuestRegisterRecord: "prepare_guest_register_record",
  queueSesHospedajesSubmission: "queue_ses_submission"
});

export type AiToolSafetyDecision = AiSafetyDecision & {
  /** Clave de la matriz de riesgo aplicada; null cuando la decisión deriva solo del registro. */
  riskKey: string | null;
  /**
   * true = rechazo firme (hechos peligrosos, permisos ausentes): la herramienta no debe
   * ejecutarse ni quedar pendiente. false con allowed:false = «confirmar o aprobar antes».
   */
  denied: boolean;
};

export function riskKeyForTool(toolName: string): string | null {
  const mapped = (TOOL_RISK_KEYS as Record<string, string | undefined>)[toolName];
  if (mapped && RISK_MATRIX.some((entry) => entry.key === mapped)) return mapped;
  return null;
}

/**
 * Evalúa la seguridad de una herramienta del registro. Con clave mapeada delega en
 * evaluateAiSafety (matriz de riesgo + hechos); sin clave deriva la decisión de la definición:
 * lectura low/medium → permitida; escritura o riesgo high → allowed:false con confirmación;
 * critical → aprobación de "manager". Nunca lanza.
 */
export function evaluateAiSafetyForTool(input: {
  toolName: string;
  definition: Pick<ToolDefinition, "riskLevel" | "requiresConfirmation" | "effect">;
  permissions: PermissionKey[];
  facts?: AiSafetyFacts;
}): AiToolSafetyDecision {
  const riskKey = riskKeyForTool(input.toolName);
  const facts = input.facts ?? {};

  if (riskKey) {
    try {
      const decision = evaluateAiSafety({ actionKey: riskKey, permissions: input.permissions, facts });
      return { ...decision, riskKey, denied: isHardDenial(decision) };
    } catch {
      // Sin entrada en la matriz (no debería pasar: riskKeyForTool la comprueba): cae al registro.
    }
  }

  if (facts.storesIdImage) {
    return { ...deny(input.toolName, "critical", "ID document images must be discarded after extraction."), riskKey: null, denied: true };
  }

  const { riskLevel, effect } = input.definition;
  if (riskLevel === "critical") {
    return {
      allowed: false,
      actionKey: input.toolName,
      riskLevel,
      requiresConfirmation: true,
      requiredApproval: "manager",
      reason: "Critical actions require manager approval.",
      riskKey: null,
      denied: false
    };
  }
  if (effect === "write" || riskLevel === "high") {
    return {
      allowed: false,
      actionKey: input.toolName,
      riskLevel,
      requiresConfirmation: true,
      reason: "Action must be confirmed or approved before execution.",
      riskKey: null,
      denied: false
    };
  }
  return {
    allowed: true,
    actionKey: input.toolName,
    riskLevel,
    requiresConfirmation: input.definition.requiresConfirmation,
    riskKey: null,
    denied: false
  };
}

function isHardDenial(decision: AiSafetyDecision): boolean {
  return !decision.allowed && !decision.requiresConfirmation && !decision.requiredApproval;
}
