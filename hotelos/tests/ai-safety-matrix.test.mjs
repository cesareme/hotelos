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
});

