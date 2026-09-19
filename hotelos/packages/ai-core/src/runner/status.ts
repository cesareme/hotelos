// Vocabulario de estado de ai_tool_calls (columna `status` libre en Prisma).
// Unión de 7 valores: los 5 del pipeline (succeeded | failed | pending |
// awaiting_confirmation | rejected) más los 2 legados que exigen
// tests/integration/l2-modulos-ia.test.mts:148 y docs/api-contracts.md:365
// (completed | skipped) y que persisten los llamadores históricos. El panel
// cuenta éxito con isSuccess y espera con isAwaiting (pipeline.service.ts).

export const TOOL_CALL_STATUSES = ["succeeded", "failed", "pending", "awaiting_confirmation", "rejected", "completed", "skipped"] as const;

export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export function isToolCallStatus(value: unknown): value is ToolCallStatus {
  return typeof value === "string" && (TOOL_CALL_STATUSES as readonly string[]).includes(value);
}

/** succeeded | completed: la herramienta terminó (completed = vocabulario legado del check-in y de messaging). */
export function isSuccess(status: string | null | undefined): boolean {
  return status === "succeeded" || status === "completed";
}

/** awaiting_confirmation | pending: hay una persona por decidir (pending = vocabulario legado del check-in L2). */
export function isAwaiting(status: string | null | undefined): boolean {
  return status === "awaiting_confirmation" || status === "pending";
}

/** failed | rejected: la llamada no produjo efecto. */
export function isTerminalFailure(status: string | null | undefined): boolean {
  return status === "failed" || status === "rejected";
}
