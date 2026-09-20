// Spanish labels and key-aware formatting for the AI human-review queue
// (Cocoa 22 · ola 2 · lote 2-B · fix qa#15). The API ships `reviewType`,
// `relatedEntityType` and the `payloadJson` keys as raw English identifiers
// (`rate_recommendation`, `currentRate`, `riskLevel: "high"`); the drawer used
// to paint them merely word-split («Rate Recommendation», «Current Rate»).
// Every dictionary falls back to the humanised key so unknown producers still
// render something readable. Pure module (no JSX) so it is unit-testable.

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

/** Review types produced today (seed + email connector). */
export const REVIEW_TYPE_LABELS: Record<string, string> = {
  rate_recommendation: "Recomendación de tarifa",
  invoice_issue: "Incidencia de factura",
  guest_register_submit: "Envío del registro de viajeros",
  review_response: "Respuesta a una reseña",
  email_reservation: "Reserva por correo electrónico",
  // Tanda T9 (documentos y digitalización): cola de la oficina (enqueueReview del pipeline, con o sin proveedor de IA).
  incoming_document: "Documento digitalizado"
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
  incoming_document: "Documento entrante"
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
  draft: "Borrador de reserva"
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
