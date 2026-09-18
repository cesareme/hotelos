import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

describe("AI safety matrix contract", () => {
  it("has a central AI safety evaluator", () => {
    const safety = readFileSync(new URL("../packages/ai-tools/src/safety.ts", import.meta.url), "utf8");
    assert.match(safety, /evaluateAiSafety/);
    assert.match(safety, /storesIdImage/);
    assert.match(safety, /guestRegisterMissingFields/);
    assert.match(safety, /roomBlocked/);
    assert.match(safety, /taxConfigValid/);
    assert.match(safety, /priceCameFromAvailabilityTool/);
  });

  it("covers the required escalation and refusal scenarios", () => {
    const safety = readFileSync(new URL("../packages/ai-tools/src/safety.ts", import.meta.url), "utf8");
    for (const phrase of [
      "ID document images must be discarded",
      "Blocked rooms cannot be assigned",
      "invalid tax configuration",
      "availability tool",
      "High-value refunds require manager approval",
      "Penalty overrides require manager approval"
    ]) {
      assert.match(safety, new RegExp(phrase));
    }
  });

  it("registers quote availability and cancel booking risk entries", () => {
    const riskMatrix = readFileSync(new URL("../packages/compliance/src/risk-matrix.ts", import.meta.url), "utf8");
    assert.match(riskMatrix, /quote_availability/);
    assert.match(riskMatrix, /cancel_booking/);
  });

  it("exports the safety evaluator from ai-tools", () => {
    const index = readFileSync(new URL("../packages/ai-tools/src/index.ts", import.meta.url), "utf8");
    assert.match(index, /safety/);
  });

  // Tanda L6a (lote 3): el tool runner evalúa la seguridad por nombre del registro
  // (camelCase) a través de un mapa a las claves de la matriz (snake_case), y la
  // matriz cubre las herramientas con execute real.
  it("maps registry tool names to risk-matrix keys and registers the runner's risk entries", () => {
    const safety = readFileSync(new URL("../packages/ai-tools/src/safety.ts", import.meta.url), "utf8");
    assert.match(safety, /export const TOOL_RISK_KEYS/);
    assert.match(safety, /export function evaluateAiSafetyForTool/);
    for (const pair of ["checkInReservation: \"check_in_guest\"", "assignRoom: \"assign_room\"", "sendGuestMessage: \"send_guest_message\"", "queueSesHospedajesSubmission: \"queue_ses_submission\""]) {
      assert.ok(safety.includes(pair), `safety.ts debe mapear ${pair}`);
    }

    const riskMatrix = readFileSync(new URL("../packages/compliance/src/risk-matrix.ts", import.meta.url), "utf8");
    for (const key of [
      "create_housekeeping_task",
      "answer_guest_question",
      "analyze_review_sentiment",
      "classify_document",
      "mark_room_clean",
      "send_guest_message",
      "draft_review_response",
      "extract_identity_document",
      "extract_document_fields",
      "block_room_for_maintenance",
      "prepare_guest_register_record",
      "queue_ses_submission"
    ]) {
      assert.match(riskMatrix, new RegExp(`key: "${key}"`), `risk-matrix.ts debe registrar ${key}`);
    }
    assert.match(riskMatrix, /export function getRiskEntry/);
  });
});

