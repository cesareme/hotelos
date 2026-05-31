import type { PermissionKey, RiskLevel } from "@hotelos/shared";
import { getRiskEntry } from "@hotelos/compliance";

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
