import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  entityTypeLabel,
  formatPayloadValue,
  humanizeKey,
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
