// Spanish labels and key-aware formatting for the AI human-review queue
// (Cocoa 22 · ola 2 · lote 2-B · fix qa#15). The API ships `reviewType`,
// `relatedEntityType` and the `payloadJson` keys as raw English identifiers
// (`rate_recommendation`, `currentRate`, `riskLevel: "high"`); the drawer used
// to paint them merely word-split («Rate Recommendation», «Current Rate»).
// Every dictionary falls back to the humanised key so unknown producers still
// render something readable. Pure module (no JSX) so it is unit-testable.
// Tanda L6b (lote L6b-09): the `ai_tool_call` items of the tool runner and the
// label / tone / sentence of every outcome of POST /ai/tool-calls/:id/confirm.

import { STATUS_LABELS } from "../../content/actions";
import { dateTime, money, number, percent } from "../../lib/format";

/** Reserved key of the decision/lifecycle envelope the API stashes in payloadJson. */
export const REVIEW_ENVELOPE_KEY = "_review";

/** Decision metadata the API keeps under payloadJson._review (see human-review.service.ts). */
export type ReviewEnvelope = {
  decidedBy?: string;
  decidedAt?: string;
  notes?: string;
  reason?: string;
  escalatedTo?: string;
  assignedAt?: string;
  history?: Array<{ action: string; userId: string; at: string; detail?: string }>;
};

/** «guest_name» / «guestName» → «Guest name» (generic fallback, no dictionary). */
export function humanizeKey(key: string): string {
  const text = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

/**
 * Review types produced today (every `reviewType` the API writes: seeds, email
 * connector, documents pipeline, AI core). Corrector UX2-REV-05: the seed of
 * dirección (`guest_message_reply`, `rate_change`) and the AI core
 * (`ai_tool_call`, `incoming_document_autonomous`) reached dirección as
 * humanised English («Guest message reply»); no enum reaches the screen now.
 */
export const REVIEW_TYPE_LABELS: Record<string, string> = {
  rate_recommendation: "Recomendación de tarifa",
  rate_change: "Cambio de tarifa",
  invoice_issue: "Incidencia de factura",
  guest_register_submit: "Envío del registro de viajeros",
  guest_message_reply: "Respuesta a un mensaje del huésped",
  review_response: "Respuesta a una reseña",
  email_reservation: "Reserva por correo electrónico",
  // Tanda L6a (núcleo de IA): herramienta de alto riesgo que espera la confirmación humana.
  // Tanda L6b (L6b-09): escritura high|critical que el tool runner dejó awaiting_confirmation (ai-core runner.ts, enqueueReview);
  // aprobar la ejecuta (POST /ai/tool-calls/:id/confirm), de ahí la etiqueta «propuesta».
  ai_tool_call: "Acción propuesta por la IA",
  // Tanda T9 (documentos y digitalización): cola de la oficina (enqueueReview del pipeline, con o sin proveedor de IA).
  incoming_document: "Documento digitalizado",
  incoming_document_autonomous: "Documento clasificado por la IA"
};

export function reviewTypeLabel(type: string): string {
  return REVIEW_TYPE_LABELS[type] ?? humanizeKey(type);
}

/** `relatedEntityType` values produced today. */
export const ENTITY_TYPE_LABELS: Record<string, string> = {
  rate_plan: "Plan de tarifas",
  invoice: "Factura",
  guest_register_entry: "Registro de viajero",
  guest_review: "Reseña",
  inbound_email: "Correo entrante",
  reservation: "Reserva",
  guest: "Huésped",
  incoming_document: "Documento entrante",
  // Tanda L6b (L6b-09): `relatedEntityId` es la fila ai_tool_calls; aprobar ejecuta (ver isAiToolCallReview).
  ai_tool_call: "Acción propuesta por la IA"
};

export function entityTypeLabel(type: string): string {
  return ENTITY_TYPE_LABELS[type] ?? humanizeKey(type);
}

/** Known payloadJson keys (seed: rate / invoice / register / review; connector: email). */
export const PAYLOAD_KEY_LABELS: Record<string, string> = {
  summary: "Resumen",
  riskLevel: "Nivel de riesgo",
  confidence: "Confianza",
  ocrConfidence: "Confianza del OCR",
  currentRate: "Tarifa actual",
  suggestedRate: "Tarifa sugerida",
  invoiceTotal: "Importe de la factura",
  suspectedDuplicateOf: "Posible duplicado de",
  documentType: "Tipo de documento",
  draftReply: "Respuesta propuesta",
  from: "Remitente",
  subject: "Asunto",
  source: "Origen",
  parseSource: "Origen del análisis",
  draft: "Borrador de reserva",
  // Tanda L6b (L6b-09): payloadJson de los ítems ai_tool_call (toolName, riskLevel, proposal, requiresApprovalRole).
  toolName: "Herramienta",
  proposal: "Propuesta",
  requiresApprovalRole: "Rol que debe aprobar",
  // Claves habituales de `proposal` (preview de las herramientas de escritura: operations/pms.tools.ts).
  action: "Acción",
  workOrderId: "Orden de trabajo",
  roomNumber: "Habitación",
  reservationId: "Reserva"
};

export function payloadKeyLabel(key: string): string {
  return PAYLOAD_KEY_LABELS[key] ?? humanizeKey(key);
}

export const RISK_LEVEL_LABELS: Record<string, string> = {
  critical: "Crítico",
  high: "Alto",
  medium: "Medio",
  low: "Bajo"
};

export const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  passport: "Pasaporte",
  dni: "DNI",
  nie: "NIE",
  id_card: "Documento de identidad",
  residence_permit: "Permiso de residencia",
  driving_license: "Permiso de conducir"
};

/** `_review.history[].action` values written by the API. */
export const HISTORY_ACTION_LABELS: Record<string, string> = {
  assigned: "Asignada",
  approved: "Aprobada",
  rejected: "Rechazada",
  escalated: "Escalada"
};

export function historyActionLabel(action: string): string {
  return HISTORY_ACTION_LABELS[action] ?? humanizeKey(action);
}

const MONEY_KEYS = new Set(["currentRate", "suggestedRate", "invoiceTotal", "amount", "total"]);
const CONFIDENCE_KEYS = new Set(["confidence", "ocrConfidence"]);
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Key-aware rendering of a payload value: money for rate/total keys, «61 %»
 * for confidence (seed ships ratios 0–1, the email connector whole percents),
 * dictionaries for risk level and document type, `Sí`/`No` for booleans,
 * dates for ISO timestamps, one level of «clave: valor» for nested objects.
 */
export function formatPayloadValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? STATUS_LABELS.yes : STATUS_LABELS.no;
  if (typeof value === "number") {
    if (MONEY_KEYS.has(key)) return money(value);
    if (CONFIDENCE_KEYS.has(key)) return percent(value, value <= 1 ? { ratio: true, maximumFractionDigits: 0 } : { maximumFractionDigits: 0 });
    return number(value);
  }
  if (typeof value === "string") {
    if (key === "riskLevel") return RISK_LEVEL_LABELS[value] ?? value;
    if (key === "documentType") return DOCUMENT_TYPE_LABELS[value] ?? value;
    if (ISO_DATE_TIME.test(value)) return dateTime(value);
    return value;
  }
  if (isPlainObject(value)) {
    const parts = Object.entries(value).map(([k, v]) => `${payloadKeyLabel(k)}: ${formatPayloadValue(k, v)}`);
    return parts.length ? parts.join(" · ") : "—";
  }
  return JSON.stringify(value);
}

/** Splits payloadJson into the visible fields and the reserved `_review` envelope. */
export function splitReviewPayload(payload: Record<string, unknown> | null | undefined): {
  fields: Array<[string, unknown]>;
  envelope: ReviewEnvelope | null;
} {
  const entries = Object.entries(payload ?? {});
  const fields = entries.filter(([key]) => key !== REVIEW_ENVELOPE_KEY);
  const raw = payload?.[REVIEW_ENVELOPE_KEY];
  const envelope = isPlainObject(raw) && Object.keys(raw).length > 0 ? (raw as ReviewEnvelope) : null;
  return { fields, envelope };
}

/** Envelope → ordered «label / value» rows (only the fields present). */
export function reviewEnvelopeRows(envelope: ReviewEnvelope): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (envelope.assignedAt) rows.push({ label: "Asignada el", value: dateTime(envelope.assignedAt) });
  if (envelope.escalatedTo) rows.push({ label: "Escalada a", value: humanizeKey(envelope.escalatedTo) });
  if (envelope.decidedBy) rows.push({ label: "Decidida por", value: envelope.decidedBy });
  if (envelope.decidedAt) rows.push({ label: "Decidida el", value: dateTime(envelope.decidedAt) });
  if (envelope.notes) rows.push({ label: "Notas", value: envelope.notes });
  if (envelope.reason) rows.push({ label: "Motivo del rechazo", value: envelope.reason });
  return rows;
}

/** History entries, newest first: «Escalada · 13/09/2026, 15:58» / detail (or the actor). */
export function reviewHistoryRows(envelope: ReviewEnvelope): Array<{ key: string; label: string; value: string }> {
  const history = Array.isArray(envelope.history) ? envelope.history : [];
  return [...history]
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .map((entry, index) => ({
      key: `${entry.at ?? ""}-${entry.action}-${index}`,
      label: `${historyActionLabel(entry.action)} · ${dateTime(entry.at)}`,
      value: entry.detail && entry.detail !== entry.userId ? entry.detail : entry.userId || "—"
    }));
}

// ---------------------------------------------------------------------------
// Tanda L6b · lote L6b-09 · aprobar ejecuta la herramienta propuesta.
//
// An item whose `relatedEntityType` is `ai_tool_call` is a write the tool
// runner left `awaiting_confirmation` (packages/ai-core runner.ts,
// `enqueueReview`) and its `relatedEntityId` is the `ai_tool_calls` row. The
// queue's plain approve only closes the review (L6A audit §6.16): the decision
// of these items goes to POST /ai/tool-calls/:id/confirm, which re-checks the
// permissions, executes the tool (approve) or closes the row (reject) and
// closes the review itself with the notes / reason (runner §10.3). These
// helpers give the screen the button labels and the label, tone and sentence
// of every outcome of that call (result or typed error).
// ---------------------------------------------------------------------------

export const AI_TOOL_CALL_ENTITY_TYPE = "ai_tool_call";
/** Permission the runner demands to confirm high|critical tools (HIGH_RISK_CONFIRM_PERMISSION, runner.ts). */
export const HIGH_RISK_CONFIRM_PERMISSION = "ai.high_risk.confirm";
/** `details.code` of the 403 the confirm route answers when permissions or the approval role are missing. */
export const AI_TOOL_CONFIRM_FORBIDDEN_CODE = "AI_TOOL_CONFIRM_FORBIDDEN";
/** `details.code` of the 409 answered when the pending row is older than 24 h (it is rejected on the spot). */
export const AI_CONFIRMATION_EXPIRED_CODE = "AI_CONFIRMATION_EXPIRED";

/** True when deciding the item must go through the confirm route (the tool executes on approval). */
export function isAiToolCallReview(item: { relatedEntityType?: string | null; relatedEntityId?: string | null }): boolean {
  return item.relatedEntityType === AI_TOOL_CALL_ENTITY_TYPE && typeof item.relatedEntityId === "string" && item.relatedEntityId.length > 0;
}

/** Decision buttons of an `ai_tool_call` item: approving executes, so the label says so. */
export const AI_TOOL_CALL_ACTION_LABELS = {
  approve: "Aprobar y ejecutar",
  reject: "Rechazar"
} as const;

/** Sentence of the decision form of an `ai_tool_call` item (what approving / rejecting does). */
export function aiToolCallDecisionHint(toolName?: string | null): string {
  const tool = toolName ? ` «${toolName}»` : "";
  return `Al aprobar, la herramienta${tool} se ejecuta con la propuesta tal cual está registrada y la revisión queda aprobada; al rechazar, la propuesta se cierra sin ejecutarse. Ambas decisiones exigen el permiso ${HIGH_RISK_CONFIRM_PERMISSION} y los de la herramienta.`;
}

export type ConfirmOutcomeKind = "succeeded" | "failed" | "rejected" | "forbidden" | "expired" | "gone" | "error";
/** Subset of CocoaTone the outcome badge / callout uses. */
export type ConfirmOutcomeTone = "success" | "warning" | "danger" | "neutral";
export type ConfirmOutcome = { kind: ConfirmOutcomeKind; label: string; tone: ConfirmOutcomeTone; message: string };

/** Label and tone of every outcome of the confirm route. */
export const CONFIRM_OUTCOME_LABELS: Record<ConfirmOutcomeKind, { label: string; tone: ConfirmOutcomeTone }> = {
  succeeded: { label: "Ejecutada", tone: "success" },
  failed: { label: "Ejecución fallida", tone: "danger" },
  rejected: { label: "Rechazada", tone: "neutral" },
  forbidden: { label: "Sin permiso", tone: "danger" },
  expired: { label: "Caducada", tone: "warning" },
  gone: { label: "Ya no pendiente", tone: "warning" },
  error: { label: "Error", tone: "danger" }
};

function outcome(kind: ConfirmOutcomeKind, message: string): ConfirmOutcome {
  return { kind, ...CONFIRM_OUTCOME_LABELS[kind], message };
}

/** Mirror of the 200 body of POST /ai/tool-calls/:id/confirm (ConfirmToolResult, packages/ai-core runner/types.ts). */
export type ConfirmResultLike = { status: "succeeded" | "failed" | "rejected"; message?: string; reason?: string };

/** 200 of the confirm route → outcome: `succeeded` executed, `failed` executed and failed (row `failed`), `rejected` closed without executing. */
export function confirmResultOutcome(result: ConfirmResultLike, toolName?: string | null): ConfirmOutcome {
  const tool = toolName ? ` «${toolName}»` : "";
  if (result.status === "succeeded") return outcome("succeeded", `La herramienta${tool} se ha ejecutado y la revisión queda aprobada.`);
  if (result.status === "failed") {
    const detail = result.message?.trim() || (result.reason ? humanizeKey(result.reason) : "error desconocido");
    return outcome("failed", `La herramienta${tool} no se ha podido ejecutar: ${detail}`);
  }
  return outcome("rejected", `La propuesta${tool} se ha rechazado: la herramienta no se ejecutará.`);
}

/** Shape of the ApiError of services/api-client.ts (status + details.code) or any Error. */
export type ConfirmErrorLike = { status?: number; details?: unknown; message?: string };

/**
 * Error of the confirm route → outcome. 403 `AI_TOOL_CONFIRM_FORBIDDEN` names
 * the missing permissions (`details.missing`, else ai.high_risk.confirm) and
 * the approval role; 409 `AI_CONFIRMATION_EXPIRED` → «Caducada» (the row was
 * rejected by the API); 404 (decided, claimed or foreign row) → «Ya no
 * pendiente»; anything else keeps the API message (already in Spanish).
 */
export function confirmErrorOutcome(error: unknown): ConfirmOutcome {
  const err: ConfirmErrorLike = typeof error === "object" && error !== null ? (error as ConfirmErrorLike) : {};
  const details = isPlainObject(err.details) ? err.details : {};
  const code = typeof details.code === "string" ? details.code : "";
  const message = typeof err.message === "string" && err.message.trim() ? err.message.trim() : String(error);
  if (err.status === 403) {
    if (code !== AI_TOOL_CONFIRM_FORBIDDEN_CODE) return outcome("forbidden", message);
    const missing = Array.isArray(details.missing) ? details.missing.filter((value): value is string => typeof value === "string" && value.length > 0) : [];
    const role = typeof details.requiresApprovalRole === "string" && details.requiresApprovalRole ? details.requiresApprovalRole : "";
    const needs = missing.length > 0 ? missing.join(", ") : HIGH_RISK_CONFIRM_PERMISSION;
    const roleNote = role ? ` La herramienta exige la aprobación del rol ${humanizeKey(role)}.` : "";
    return outcome("forbidden", `No se ha ejecutado: necesitas ${needs} para confirmar esta acción.${roleNote}`);
  }
  if (err.status === 409 && code === AI_CONFIRMATION_EXPIRED_CODE) {
    return outcome("expired", "La propuesta llevaba más de 24 h pendiente: ha caducado y se ha rechazado sin ejecutarse.");
  }
  if (err.status === 404) {
    return outcome("gone", "La acción ya no está pendiente de confirmación (decidida, caducada o reclamada por otra persona). Actualiza la cola.");
  }
  return outcome("error", message);
}
