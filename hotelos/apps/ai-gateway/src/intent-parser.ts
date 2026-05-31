import type { AiIntent, AiIntentName, RiskLevel } from "@hotelos/shared";

const INTENT_RULES: Array<{
  intent: AiIntentName;
  pattern: RegExp;
  riskLevel: RiskLevel;
  requiredTools: string[];
  requiresConfirmation: boolean;
}> = [
  {
    intent: "CHECK_IN_GUEST",
    pattern: /check\s*in|check-in/i,
    riskLevel: "high",
    requiredTools: [
      "matchGuestToReservation",
      "validateRoomAssignment",
      "checkGuestRegisterCompleteness",
      "checkInReservation",
      "queueSesHospedajesSubmission",
      "sendGuestMessage"
    ],
    requiresConfirmation: true
  },
  {
    intent: "CREATE_MAINTENANCE_WORK_ORDER",
    pattern: /maintenance|broken|leak|not working|repair/i,
    riskLevel: "low",
    requiredTools: ["createWorkOrder"],
    requiresConfirmation: false
  },
  {
    intent: "ASK_DASHBOARD_QUESTION",
    pattern: /today.?s arrivals|arrivals today|show.*arrivals/i,
    riskLevel: "low",
    requiredTools: ["findReservation"],
    requiresConfirmation: false
  },
  {
    intent: "ASSIGN_ROOM",
    pattern: /assign room|room .* to reservation/i,
    riskLevel: "medium",
    requiredTools: ["validateRoomAssignment", "assignRoom"],
    requiresConfirmation: true
  },
  {
    intent: "QUOTE_AVAILABILITY",
    pattern: /availability|do you have|book|reserve/i,
    riskLevel: "medium",
    requiredTools: ["quoteAvailability"],
    requiresConfirmation: false
  }
];

export function parseCommandToIntent(input: {
  transcript: string;
  propertyId: string;
  userId: string;
}): AiIntent {
  const rule = INTENT_RULES.find((candidate) => candidate.pattern.test(input.transcript));
  const roomNumber = input.transcript.match(/\broom\s*(\d+[A-Za-z]?)\b/i)?.[1];
  const reservationCode = input.transcript.match(/\bRES[-\s]?(\d+)\b/i)?.[1];

  if (!rule) {
    return {
      intent: "ASK_DASHBOARD_QUESTION",
      propertyId: input.propertyId,
      userId: input.userId,
      extractedEntities: {},
      confidence: 0.45,
      requiredTools: [],
      requiresConfirmation: false,
      riskLevel: "low"
    };
  }

  return {
    intent: rule.intent,
    propertyId: input.propertyId,
    userId: input.userId,
    extractedEntities: { roomNumber, reservationCode: reservationCode ? `RES-${reservationCode}` : undefined },
    confidence: roomNumber ? 0.92 : 0.76,
    requiredTools: rule.requiredTools,
    requiresConfirmation: rule.requiresConfirmation,
    riskLevel: rule.riskLevel
  };
}

export const GUEST_AI_DISCLOSURE =
  "Hi, I'm the hotel's AI assistant. I can help with availability, bookings, hotel information, and service requests. A staff member can take over whenever needed.";
