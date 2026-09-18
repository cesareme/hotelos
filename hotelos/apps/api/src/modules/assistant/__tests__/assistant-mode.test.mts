// deriveAssistantMode (Tanda L6a, lote 2): el modo `llm` solo cuando un modelo
// respondió de verdad; nunca por la mera presencia de una clave.
// Run: cd apps/api && node --import tsx --test src/modules/assistant/__tests__/assistant-mode.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveAssistantMode } from "../assistant.service.js";

describe("assistant · deriveAssistantMode", () => {
  it("sin resultados → deterministic", () => {
    assert.equal(deriveAssistantMode([]), "deterministic");
  });

  it("resultados sin modelAnswered → deterministic (aunque exista clave en el entorno)", () => {
    const results = [
      { result: { ok: true } },
      { result: { ok: false } },
      { result: { ok: true, modelAnswered: false } }
    ];
    assert.equal(deriveAssistantMode(results), "deterministic");
  });

  it("algún resultado con modelAnswered:true → llm", () => {
    assert.equal(deriveAssistantMode([{ result: { ok: true } }, { result: { ok: true, modelAnswered: true } }]), "llm");
  });
});
