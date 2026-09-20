import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AI_TOOL_CALL_ACTION_LABELS,
  CONFIRM_OUTCOME_LABELS,
  aiToolCallDecisionHint,
  confirmErrorOutcome,
  confirmResultOutcome,
  entityTypeLabel,
  formatPayloadValue,
  humanizeKey,
  isAiToolCallReview,
  payloadKeyLabel,
  reviewEnvelopeRows,
  reviewHistoryRows,
  reviewTypeLabel,
  splitReviewPayload
} from "../ai-review-labels.ts";

// Regression of qa#15 (Cocoa 22 · ola 2 · lote 2-B): the review drawer painted
// the raw API identifiers word-split in English («Rate Recommendation»,
// «Risk Level: high», «Confidence: 0,61», «Current Rate»). Fixtures are the
// live payloads of the demo queue (GET /ai-operations/review/queue, org_123).

/** Intl es-ES separates «€» and «%» with U+00A0/U+202F; compare with a plain space. */
const plain = (text: string) => text.replace(/[  ]/g, " ");
const format = (key: string, value: unknown) => plain(formatPayloadValue(key, value));

const RATE_001 = {
  summary: "AI suggests raising BAR Double by 18% for the weekend on high demand.",
  riskLevel: "high",
  confidence: 0.61,
  currentRate: 120,
  suggestedRate: 142
};

const RATE_005 = {
  _review: {
    history: [
      { at: "2026-07-12T00:28:16.993Z", action: "escalated", detail: "revenue_manager", userId: "usr_123" },
      { at: "2026-09-13T13:58:44.172Z", action: "assigned", detail: "usr_123", userId: "usr_123" }
    ],
    assignedAt: "2026-09-13T13:58:44.172Z",
    escalatedTo: "revenue_manager"
  },
  summary: "AI suggests dropping Suite rate 25% during a competitor event.",
  confidence: 0.55,
  currentRate: 280,
  suggestedRate: 210
};

describe("ai-review-labels · tipos y entidades (qa#15)", () => {
  it("translates every review type the API produces today", () => {
    assert.equal(reviewTypeLabel("rate_recommendation"), "Recomendación de tarifa");
    assert.equal(reviewTypeLabel("invoice_issue"), "Incidencia de factura");
    assert.equal(reviewTypeLabel("guest_register_submit"), "Envío del registro de viajeros");
    assert.equal(reviewTypeLabel("review_response"), "Respuesta a una reseña");
    assert.equal(reviewTypeLabel("email_reservation"), "Reserva por correo electrónico");
  });

  it("falls back to the humanised key for unknown producers", () => {
    assert.equal(reviewTypeLabel("channel_overbooking"), "Channel overbooking");
    assert.equal(humanizeKey("guestName"), "Guest name");
    assert.equal(payloadKeyLabel("competitorEvent"), "Competitor event");
  });

  it("translates the related entity types", () => {
    assert.equal(entityTypeLabel("rate_plan"), "Plan de tarifas");
    assert.equal(entityTypeLabel("invoice"), "Factura");
    assert.equal(entityTypeLabel("guest_register_entry"), "Registro de viajero");
    assert.equal(entityTypeLabel("guest_review"), "Reseña");
    assert.equal(entityTypeLabel("inbound_email"), "Correo entrante");
  });
});

describe("ai-review-labels · contenido de la propuesta (qa#15)", () => {
  it("renders rev_rate_001 with Spanish labels and formatted values", () => {
    const { fields, envelope } = splitReviewPayload(RATE_001);
    assert.equal(envelope, null);
    const rendered = fields.map(([key, value]) => [payloadKeyLabel(key), format(key, value)]);
    assert.deepEqual(rendered, [
      ["Resumen", RATE_001.summary],
      ["Nivel de riesgo", "Alto"],
      ["Confianza", "61 %"],
      ["Tarifa actual", "120,00 €"],
      ["Tarifa sugerida", "142,00 €"]
    ]);
  });

  it("formats the other seeded payload keys", () => {
    assert.equal(payloadKeyLabel("invoiceTotal"), "Importe de la factura");
    assert.equal(format("invoiceTotal", 432.5), "432,50 €");
    assert.equal(payloadKeyLabel("suspectedDuplicateOf"), "Posible duplicado de");
    assert.equal(payloadKeyLabel("documentType"), "Tipo de documento");
    assert.equal(format("documentType", "passport"), "Pasaporte");
    assert.equal(payloadKeyLabel("ocrConfidence"), "Confianza del OCR");
    assert.equal(format("ocrConfidence", 0.39), "39 %");
    assert.equal(payloadKeyLabel("draftReply"), "Respuesta propuesta");
  });

  it("accepts whole-percent confidence from the email connector and nested drafts", () => {
    assert.equal(format("confidence", 61), "61 %");
    assert.equal(payloadKeyLabel("from"), "Remitente");
    assert.equal(payloadKeyLabel("subject"), "Asunto");
    assert.equal(formatPayloadValue("draft", { guestName: "Ana", nights: 2, breakfast: true }), "Guest name: Ana · Nights: 2 · Breakfast: Sí");
  });

  it("keeps generic values honest: empty, booleans, plain numbers", () => {
    assert.equal(formatPayloadValue("anything", null), "—");
    assert.equal(formatPayloadValue("anything", ""), "—");
    assert.equal(formatPayloadValue("flag", false), "No");
    assert.equal(formatPayloadValue("nights", 1234), "1234");
  });
});

describe("ai-review-labels · sobre _review (hallazgo extra de qa#15)", () => {
  it("keeps the envelope out of the content list and exposes it separately", () => {
    const { fields, envelope } = splitReviewPayload(RATE_005);
    assert.deepEqual(
      fields.map(([key]) => key),
      ["summary", "confidence", "currentRate", "suggestedRate"]
    );
    assert.ok(envelope);
    assert.deepEqual(reviewEnvelopeRows(envelope), [
      { label: "Asignada el", value: "13/09/2026, 15:58" },
      { label: "Escalada a", value: "Revenue manager" }
    ]);
  });

  it("lists the history newest first with Spanish actions", () => {
    const { envelope } = splitReviewPayload(RATE_005);
    assert.ok(envelope);
    const rows = reviewHistoryRows(envelope).map(({ label, value }) => ({ label, value }));
    assert.deepEqual(rows, [
      { label: "Asignada · 13/09/2026, 15:58", value: "usr_123" },
      { label: "Escalada · 12/07/2026, 02:28", value: "revenue_manager" }
    ]);
  });

  it("renders decisions (approved / rejected) with their notes and reason", () => {
    const approved = splitReviewPayload({
      summary: "x",
      _review: { decidedBy: "usr_123", decidedAt: "2026-07-12T00:53:16.993Z", notes: "Tone OK, posted." }
    }).envelope;
    assert.ok(approved);
    assert.deepEqual(reviewEnvelopeRows(approved), [
      { label: "Decidida por", value: "usr_123" },
      { label: "Decidida el", value: "12/07/2026, 02:53" },
      { label: "Notas", value: "Tone OK, posted." }
    ]);
    const rejected = splitReviewPayload({ _review: { reason: "Not fraudulent." } }).envelope;
    assert.ok(rejected);
    assert.deepEqual(reviewEnvelopeRows(rejected), [{ label: "Motivo del rechazo", value: "Not fraudulent." }]);
  });

  it("treats an empty or malformed envelope as absent", () => {
    assert.equal(splitReviewPayload({ _review: {} }).envelope, null);
    assert.equal(splitReviewPayload({ _review: "junk" }).envelope, null);
    assert.equal(splitReviewPayload(undefined).envelope, null);
  });
});

// Tanda L6b · lote L6b-09 (L6A audit §6.16 / §11.1 fila 10, AI-CORE §10.3): an
// item of the tool runner (`relatedEntityType ai_tool_call`) executes the tool
// when approved via POST /ai/tool-calls/:id/confirm. Fixtures mirror what the
// runner enqueues (runner.ts enqueueReview) and what the route answers
// (ConfirmToolResult · ForbiddenError AI_TOOL_CONFIRM_FORBIDDEN · 409
// AI_CONFIRMATION_EXPIRED · 404 opaco), as the ApiError of api-client.ts
// carries them (status + details.code).

const TOOL_CALL_ITEM = {
  id: "rev_l6b09",
  reviewType: "ai_tool_call",
  relatedEntityType: "ai_tool_call",
  relatedEntityId: "cmu_tool_call_l6b09",
  payloadJson: { toolName: "blockRoomForMaintenance", riskLevel: "high", proposal: null }
};

/** ApiError-like (services/api-client.ts): message + HTTP status + details. */
function apiError(status: number, message: string, details?: unknown) {
  const error = new Error(message) as Error & { status: number; details?: unknown };
  error.status = status;
  error.details = details;
  return error;
}

describe("ai-review-labels · acción propuesta por la IA (L6b-09)", () => {
  it("translates the ai_tool_call review and entity types", () => {
    assert.equal(entityTypeLabel("ai_tool_call"), "Acción propuesta por la IA");
    assert.equal(reviewTypeLabel("ai_tool_call"), "Acción propuesta por la IA");
  });

  it("renders the payload the runner enqueues with Spanish labels", () => {
    const { fields, envelope } = splitReviewPayload(TOOL_CALL_ITEM.payloadJson);
    assert.equal(envelope, null);
    assert.deepEqual(
      fields.map(([key, value]) => [payloadKeyLabel(key), format(key, value)]),
      [
        ["Herramienta", "blockRoomForMaintenance"],
        ["Nivel de riesgo", "Alto"],
        ["Propuesta", "—"]
      ]
    );
    assert.equal(payloadKeyLabel("requiresApprovalRole"), "Rol que debe aprobar");
    assert.equal(formatPayloadValue("proposal", { action: "blockRoomForMaintenance", workOrderId: "wo_1" }), "Acción: blockRoomForMaintenance · Orden de trabajo: wo_1");
    assert.equal(formatPayloadValue("proposal", { roomNumber: "104", blocksRoom: true }), "Habitación: 104 · Blocks room: Sí");
  });

  it("recognises the items that execute on approval (entity type + row id)", () => {
    assert.equal(isAiToolCallReview(TOOL_CALL_ITEM), true);
    assert.equal(isAiToolCallReview({ relatedEntityType: "ai_tool_call", relatedEntityId: "" }), false);
    assert.equal(isAiToolCallReview({ relatedEntityType: "ai_tool_call" }), false);
    assert.equal(isAiToolCallReview({ relatedEntityType: "rate_plan", relatedEntityId: "rp_1" }), false);
    assert.equal(isAiToolCallReview({}), false);
  });

  it("labels the decision buttons and explains what approving does", () => {
    assert.equal(AI_TOOL_CALL_ACTION_LABELS.approve, "Aprobar y ejecutar");
    assert.equal(AI_TOOL_CALL_ACTION_LABELS.reject, "Rechazar");
    const hint = aiToolCallDecisionHint("blockRoomForMaintenance");
    assert.match(hint, /«blockRoomForMaintenance» se ejecuta/);
    assert.match(hint, /ai\.high_risk\.confirm/);
    assert.match(aiToolCallDecisionHint(null), /^Al aprobar, la herramienta se ejecuta/);
  });
});

describe("ai-review-labels · resultado de confirmación → etiqueta y tono (L6b-09)", () => {
  it("maps the three 200 bodies of the confirm route", () => {
    const ok = confirmResultOutcome({ status: "succeeded" }, "blockRoomForMaintenance");
    assert.deepEqual([ok.kind, ok.label, ok.tone], ["succeeded", "Ejecutada", "success"]);
    assert.match(ok.message, /«blockRoomForMaintenance» se ha ejecutado/);

    const failed = confirmResultOutcome({ status: "failed", reason: "tool_failed", message: "La orden de trabajo no está vinculada a ninguna habitación." }, "blockRoomForMaintenance");
    assert.deepEqual([failed.kind, failed.label, failed.tone], ["failed", "Ejecución fallida", "danger"]);
    assert.match(failed.message, /no se ha podido ejecutar: La orden de trabajo no está vinculada a ninguna habitación\.$/);
    assert.match(confirmResultOutcome({ status: "failed", reason: "tool_not_implemented" }).message, /: Tool not implemented$/);

    const rejected = confirmResultOutcome({ status: "rejected" });
    assert.deepEqual([rejected.kind, rejected.label, rejected.tone], ["rejected", "Rechazada", "neutral"]);
    assert.match(rejected.message, /^La propuesta se ha rechazado/);
  });

  it("403 AI_TOOL_CONFIRM_FORBIDDEN → «Sin permiso» naming ai.high_risk.confirm or the missing permissions", () => {
    const plain = confirmErrorOutcome(apiError(403, "Faltan permisos para confirmar blockRoomForMaintenance.", { code: "AI_TOOL_CONFIRM_FORBIDDEN" }));
    assert.deepEqual([plain.kind, plain.label, plain.tone], ["forbidden", "Sin permiso", "danger"]);
    assert.equal(plain.message, "No se ha ejecutado: necesitas ai.high_risk.confirm para confirmar esta acción.");

    const missing = confirmErrorOutcome(
      apiError(403, "Faltan permisos para confirmar blockRoomForMaintenance: maintenance.workorder.manage.", { code: "AI_TOOL_CONFIRM_FORBIDDEN", missing: ["maintenance.workorder.manage"] })
    );
    assert.equal(missing.kind, "forbidden");
    assert.equal(missing.message, "No se ha ejecutado: necesitas maintenance.workorder.manage para confirmar esta acción.");

    const role = confirmErrorOutcome(apiError(403, "x", { code: "AI_TOOL_CONFIRM_FORBIDDEN", missing: ["ai.high_risk.confirm"], requiresApprovalRole: "revenue_manager" }));
    assert.equal(role.message, "No se ha ejecutado: necesitas ai.high_risk.confirm para confirmar esta acción. La herramienta exige la aprobación del rol Revenue manager.");

    // Any other 403 (route manifest, IA desactivada, presupuesto) keeps the API sentence.
    const budget = confirmErrorOutcome(apiError(403, "Presupuesto mensual de IA agotado.", { code: "AI_BUDGET_EXCEEDED", budgetEur: 1, spentEur: 2 }));
    assert.deepEqual([budget.kind, budget.label, budget.message], ["forbidden", "Sin permiso", "Presupuesto mensual de IA agotado."]);
  });

  it("409 AI_CONFIRMATION_EXPIRED → «Caducada», 404 → «Ya no pendiente», anything else keeps the message", () => {
    const expired = confirmErrorOutcome(apiError(409, "La confirmación ha caducado.", { code: "AI_CONFIRMATION_EXPIRED", ttlMs: 86400000 }));
    assert.deepEqual([expired.kind, expired.label, expired.tone], ["expired", "Caducada", "warning"]);
    assert.match(expired.message, /más de 24 h/);

    const gone = confirmErrorOutcome(apiError(404, "Llamada de herramienta no encontrada."));
    assert.deepEqual([gone.kind, gone.label, gone.tone], ["gone", "Ya no pendiente", "warning"]);

    const other409 = confirmErrorOutcome(apiError(409, "Otro conflicto."));
    assert.deepEqual([other409.kind, other409.label, other409.tone, other409.message], ["error", "Error", "danger", "Otro conflicto."]);
    const network = confirmErrorOutcome(new TypeError("Failed to fetch"));
    assert.deepEqual([network.kind, network.message], ["error", "Failed to fetch"]);
    assert.deepEqual([confirmErrorOutcome("boom").kind, confirmErrorOutcome("boom").message], ["error", "boom"]);
  });

  it("every outcome kind has a label and a Cocoa tone", () => {
    for (const [kind, entry] of Object.entries(CONFIRM_OUTCOME_LABELS)) {
      assert.ok(entry.label.length > 0, kind);
      assert.ok(["success", "warning", "danger", "neutral"].includes(entry.tone), `${kind}: ${entry.tone}`);
    }
  });
});
