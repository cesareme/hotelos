// Unit tests · referencia catastral (Tanda ACT · L0a). Sin BD. Desde apps/api:
//   node --import tsx --test src/modules/real-estate/__tests__/cadastral-reference.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CADASTRAL_REFERENCE_LENGTH, assertCadastralReference, isValidCadastralReference, normalizeCadastralReference } from "../cadastral.js";

const details = (error: unknown): { code?: string; value?: string } => ((error as { details?: { code?: string; value?: string } }).details ?? {}) as { code?: string; value?: string };
const statusOf = (error: unknown): number | undefined => (error as { statusCode?: number }).statusCode;

// Forma real: 7 (finca) + 7 (parcela) + 4 (cargo) + 2 (control) = 20 caracteres.
const VALID = "9872023VH5797S0001WX";

describe("referencia catastral", () => {
  it("acepta una referencia válida de 20 caracteres tal cual", () => {
    assert.equal(VALID.length, CADASTRAL_REFERENCE_LENGTH);
    assert.equal(isValidCadastralReference(VALID), true);
    assert.equal(assertCadastralReference(VALID), VALID);
  });

  it("normaliza minúsculas y espacios (como se imprime en la certificación) y la da por válida", () => {
    const printed = "9872023 vh5797s 0001 wx";
    assert.equal(normalizeCadastralReference(printed), VALID);
    assert.equal(isValidCadastralReference(printed), false, "sin normalizar no vale: la validación estricta es sobre el valor tal cual");
    assert.equal(assertCadastralReference(printed), VALID);
    assert.equal(assertCadastralReference("  9872023VH5797S0001WX\n"), VALID);
  });

  it("rechaza 19 caracteres con 400 INVALID_CADASTRAL_REFERENCE y el valor normalizado en details", () => {
    const short = VALID.slice(0, 19);
    assert.equal(short.length, 19);
    assert.equal(isValidCadastralReference(short), false);
    assert.throws(
      () => assertCadastralReference(short),
      (error: unknown) => statusOf(error) === 400 && details(error).code === "INVALID_CADASTRAL_REFERENCE" && details(error).value === short
    );
    assert.throws(() => assertCadastralReference(`${VALID}A`), (error: unknown) => details(error).code === "INVALID_CADASTRAL_REFERENCE", "21 caracteres tampoco");
  });

  it("rechaza guiones y otros signos: la normalización solo quita espacios", () => {
    const hyphenated = "9872023VH5797S-001WX"; // 20 caracteres, uno de ellos un guion
    assert.equal(hyphenated.length, CADASTRAL_REFERENCE_LENGTH);
    assert.equal(normalizeCadastralReference(hyphenated), hyphenated);
    assert.equal(isValidCadastralReference(hyphenated), false);
    assert.throws(() => assertCadastralReference(hyphenated), (error: unknown) => details(error).code === "INVALID_CADASTRAL_REFERENCE");
    assert.throws(() => assertCadastralReference("9872023-VH5797S-0001-WX"), (error: unknown) => details(error).code === "INVALID_CADASTRAL_REFERENCE");
    assert.throws(() => assertCadastralReference("9872023VH5797S0001Wñ"), (error: unknown) => details(error).code === "INVALID_CADASTRAL_REFERENCE", "solo [0-9A-Z]");
    assert.equal(isValidCadastralReference(""), false);
    assert.equal(isValidCadastralReference(null), false);
  });
});
