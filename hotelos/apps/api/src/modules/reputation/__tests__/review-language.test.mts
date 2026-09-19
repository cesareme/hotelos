// Unit tests · Tanda T8 · lote T8-B — detección de idioma por stopwords
// (review-language.ts). Sin base de datos, sin red. Textos ficticios.
// Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/review-language.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DETECTABLE_LANGUAGES, detectLanguage, normalizeLanguageCode, tokenizeForLanguage } from "../review-language.js";

describe("detectLanguage · tabla por idioma (reseñas ficticias)", () => {
  const table: Array<[string, string]> = [
    ["es", "El hotel estaba muy limpio y el personal fue muy amable. La habitación tenía unas vistas preciosas y el desayuno era abundante."],
    ["en", "The room was very clean and the staff were friendly. We enjoyed the breakfast and the location was great for walking."],
    ["de", "Das Zimmer war sehr sauber und das Personal war freundlich. Das Frühstück war reichhaltig und die Lage ist perfekt."],
    ["fr", "La chambre était très propre et le personnel était aimable. Le petit déjeuner était copieux et l'hôtel est bien situé."],
    ["pt", "O quarto estava muito limpo e os funcionários foram simpáticos. O café da manhã era farto e a localização é ótima."],
    ["it", "La camera era molto pulita e il personale è stato gentile. La colazione era ottima e la posizione è perfetta."]
  ];
  for (const [expected, text] of table) {
    it(`detecta ${expected}`, () => {
      const out = detectLanguage(text);
      assert.equal(out.code, expected, JSON.stringify(out.scores));
      assert.ok(out.confidence > 0.3, `confianza ${out.confidence}`);
      assert.ok(out.confidence <= 1);
    });
  }
});

describe("detectLanguage · sin evidencia → und", () => {
  it("texto vacío, nulo o solo números", () => {
    assert.equal(detectLanguage("").code, "und");
    assert.equal(detectLanguage("   ").code, "und");
    assert.equal(detectLanguage(null).code, "und");
    assert.equal(detectLanguage("12345 !!! ???").code, "und");
    assert.equal(detectLanguage("").confidence, 0);
  });
  it("galimatías sin stopwords", () => {
    assert.equal(detectLanguage("xyzzy qwv plok trfs").code, "und");
  });
  it("una sola palabra ambigua no decide", () => {
    assert.equal(detectLanguage("ok").code, "und");
  });
  it("devuelve puntuaciones para los 6 idiomas", () => {
    const out = detectLanguage("hola");
    assert.deepEqual(Object.keys(out.scores).sort(), [...DETECTABLE_LANGUAGES].sort());
  });
});

describe("helpers", () => {
  it("tokenizeForLanguage quita diacríticos y separa contracciones", () => {
    assert.deepEqual(tokenizeForLanguage("Habitación, ¡genial! Didn't"), ["habitacion", "genial", "did", "not"]);
  });
  it("normalizeLanguageCode acepta códigos del portal", () => {
    assert.equal(normalizeLanguageCode("en-GB"), "en");
    assert.equal(normalizeLanguageCode("ES"), "es");
    assert.equal(normalizeLanguageCode("pt_BR"), "pt");
    assert.equal(normalizeLanguageCode("zh"), "und");
    assert.equal(normalizeLanguageCode(null), "und");
  });
});
