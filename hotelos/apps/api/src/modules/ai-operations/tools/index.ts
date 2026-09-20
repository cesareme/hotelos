// Catálogo de implementaciones AiTool del API (Tanda L6a, lote 3): 15
// lecturas/borradores (effect "read", ejecución inmediata por el runner) y 12
// escrituras (effect "write", SIEMPRE awaiting_confirmation). Todo lo que toca
// dinero o fiscal (folio, pagos, facturas, contabilidad, capex) y el resto del
// catálogo queda SIN execute: el runner responde denied tool_not_implemented.
// Tanda CHK (W4-D): +1 lectura suggestRoomAssignment (motor de asignación
// explicable) y +1 escritura createServiceRequest (peticiones del bot del
// huésped: late check-out, toallas…; recepción confirma).

import type { HotelOsToolName } from "@hotelos/ai-tools";
import { checkInReservationTool } from "./check-in.tools.js";
import type { AiToolImpl } from "./context.js";
import { classifyIncomingDocumentTool, classifyOnboardingFileTool, extractIncomingDocumentFieldsTool } from "./documents.tools.js";
import { checkGuestRegisterCompletenessTool, extractGuestIdentityFieldsTemporaryTool, prepareGuestRegisterRecordTool, queueSesHospedajesSubmissionTool, validateSpainGuestRegisterTool } from "./guest-register.tools.js";
import { answerGuestQuestionTool, sendGuestMessageTool } from "./messaging.tools.js";
import { blockRoomForMaintenanceTool, createHousekeepingTaskTool, createWorkOrderTool, getHousekeepingBoardTool, markRoomCleanTool, markRoomInspectedTool, resolveWorkOrderTool } from "./operations.tools.js";
import { assignRoomTool, createServiceRequestTool, findReservationTool, matchGuestToReservationTool, quoteAvailabilityTool, suggestRoomAssignmentTool, validateRoomAssignmentTool } from "./pms.tools.js";
import { analyzeReviewSentimentTool, draftReviewResponseTool } from "./reputation.tools.js";

export type { AiToolImpl, ApiToolContext } from "./context.js";
export { apiToolContext, apiToolContextFromRunner, defineAiTool, parseToolInput } from "./context.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAiToolImpl = AiToolImpl<any, any>;

const IMPLEMENTATIONS: AnyAiToolImpl[] = [
  // Lecturas y borradores (15)
  findReservationTool,
  matchGuestToReservationTool,
  validateRoomAssignmentTool,
  quoteAvailabilityTool,
  suggestRoomAssignmentTool,
  checkGuestRegisterCompletenessTool,
  validateSpainGuestRegisterTool,
  getHousekeepingBoardTool,
  classifyOnboardingFileTool,
  analyzeReviewSentimentTool,
  classifyIncomingDocumentTool,
  extractIncomingDocumentFieldsTool,
  extractGuestIdentityFieldsTemporaryTool,
  draftReviewResponseTool,
  answerGuestQuestionTool,
  // Escrituras (12): siempre awaiting_confirmation
  assignRoomTool,
  checkInReservationTool,
  createWorkOrderTool,
  blockRoomForMaintenanceTool,
  resolveWorkOrderTool,
  createHousekeepingTaskTool,
  markRoomCleanTool,
  markRoomInspectedTool,
  prepareGuestRegisterRecordTool,
  queueSesHospedajesSubmissionTool,
  sendGuestMessageTool,
  createServiceRequestTool
];

export const AI_TOOL_IMPLEMENTATIONS: Record<string, AnyAiToolImpl> = Object.freeze(Object.fromEntries(IMPLEMENTATIONS.map((impl) => [impl.name, impl])));

export const AI_READ_TOOL_NAMES: readonly HotelOsToolName[] = Object.freeze(IMPLEMENTATIONS.filter((impl) => impl.effect === "read").map((impl) => impl.name));
export const AI_WRITE_TOOL_NAMES: readonly HotelOsToolName[] = Object.freeze(IMPLEMENTATIONS.filter((impl) => impl.effect === "write").map((impl) => impl.name));

export function getAiToolImplementation(name: string): AnyAiToolImpl | null {
  return AI_TOOL_IMPLEMENTATIONS[name] ?? null;
}
