// Unit tests · Tanda T8 · lote T8-B — análisis determinista por diccionario
// (review-categories.dictionary.ts): negación, intensificadores, snippets,
// subpuntuaciones de portal. Sin base de datos, sin red. Textos ficticios.
// Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/review-categories-dictionary.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REVIEW_CATEGORIES, type CategoryMention, type ReviewCategory } from "../reputation-types.js";
import {
  DICTIONARY_FULL_LANGUAGES,
  DICTIONARY_LANGUAGES,
  SNIPPET_MAX_LENGTH,
  analyzeReviewDeterministic,
  mapPortalSubscores,
  mergeMentions,
  polarityFromMentions,
  resolveDictionaryLanguage,
  splitClauses
} from "../review-categories.dictionary.js";

function byCategory(mentions: CategoryMention[]): Map<ReviewCategory, CategoryMention> {
  return new Map(mentions.map((mention) => [mention.category, mention]));
}

describe("analyzeReviewDeterministic · tabla con negación (es/en/de/fr/pt)", () => {
  const table: Array<{ lang: string; text: string; expect: Partial<Record<ReviewCategory, -1 | 0 | 1>> }> = [
    { lang: "es", text: "La habitación no estaba limpia.", expect: { limpieza: -1, habitacion: 0 } },
    { lang: "es", text: "La habitación estaba muy limpia.", expect: { limpieza: 1 } },
    { lang: "es", text: "Sin ruido, se descansa muy bien.", expect: { ruido: 1 } },
    { lang: "es", text: "El personal fue muy amable pero el desayuno era escaso y caro.", expect: { personal: 1, desayuno: -1, precio_valor: -1 } },
    { lang: "es", text: "El wifi no funcionaba y el grifo goteaba.", expect: { wifi: -1, mantenimiento: -1 } },
    { lang: "es", text: "Hotel céntrico, a dos pasos de la playa.", expect: { ubicacion: 1 } },
    { lang: "en", text: "The room was not clean and the wifi didn't work.", expect: { limpieza: -1, wifi: -1 } },
    { lang: "en", text: "Very friendly staff and a great location, but the breakfast was disappointing.", expect: { personal: 1, ubicacion: 1, desayuno: -1 } },
    { lang: "en", text: "No noise at all, we slept well.", expect: { ruido: 1 } },
    { lang: "en", text: "Overpriced for what you get.", expect: { precio_valor: -1 } },
    { lang: "de", text: "Das Zimmer war nicht sauber.", expect: { limpieza: -1 } },
    { lang: "de", text: "Das Personal war sehr freundlich.", expect: { personal: 1 } },
    { lang: "fr", text: "La chambre n'était pas propre.", expect: { limpieza: -1 } },
    { lang: "fr", text: "Le petit déjeuner était copieux.", expect: { desayuno: 1 } },
    { lang: "pt", text: "O quarto era pequeno, mas a equipe foi muito atenciosa.", expect: { habitacion: -1, personal: 1 } },
    { lang: "pt", text: "O wifi não funcionava.", expect: { wifi: -1 } }
  ];
  for (const row of table) {
    it(`[${row.lang}] ${row.text}`, () => {
      const mentions = byCategory(analyzeReviewDeterministic(row.text, row.lang));
      for (const [category, sentiment] of Object.entries(row.expect) as Array<[ReviewCategory, -1 | 0 | 1]>) {
        const mention = mentions.get(category);
        assert.ok(mention, `falta la categoría ${category}: ${JSON.stringify([...mentions.values()])}`);
        assert.equal(mention.sentiment, sentiment, `${category} esperaba ${sentiment}`);
        assert.equal(mention.source, "dictionary");
        assert.ok(mention.confidence > 0 && mention.confidence <= 1);
      }
    });
  }
});

describe("analyzeReviewDeterministic · propiedades", () => {
  it("texto vacío o sin términos → []", () => {
    assert.deepEqual(analyzeReviewDeterministic("", "es"), []);
    assert.deepEqual(analyzeReviewDeterministic(null, "es"), []);
    assert.deepEqual(analyzeReviewDeterministic("xyzzy qwv plok", "es"), []);
  });
  it("el intensificador sube la confianza 0,1", () => {
    const plain = byCategory(analyzeReviewDeterministic("La habitación estaba limpia.", "es")).get("limpieza");
    const strong = byCategory(analyzeReviewDeterministic("La habitación estaba muy limpia.", "es")).get("limpieza");
    assert.ok(plain && strong);
    assert.equal(Math.round((strong.confidence - plain.confidence) * 100) / 100, 0.1);
  });
  it("la negación solo actúa en la ventana de 3 tokens", () => {
    const near = byCategory(analyzeReviewDeterministic("no me pareció nada limpio", "es")).get("limpieza");
    const far = byCategory(analyzeReviewDeterministic("no diría que el baño estuviera precisamente impecable, pero limpio sí", "es")).get("limpieza");
    assert.equal(near?.sentiment, -1);
    assert.ok(far, "debe mencionar limpieza");
  });
  it("el snippet es la cláusula y nunca supera 160 caracteres", () => {
    const long = `El personal fue amable ${"y siempre atento a todo lo que pedíamos durante la estancia ".repeat(6)}de verdad`;
    const mention = byCategory(analyzeReviewDeterministic(long, "es")).get("personal");
    assert.ok(mention?.snippet);
    assert.ok(mention.snippet.length <= SNIPPET_MAX_LENGTH, `snippet de ${mention.snippet.length}`);
    assert.ok(mention.snippet.endsWith("…"));
    const short = byCategory(analyzeReviewDeterministic("Personal amable.", "es")).get("personal");
    assert.equal(short?.snippet, "Personal amable.");
  });
  it("las menciones salen en el orden de REVIEW_CATEGORIES", () => {
    const mentions = analyzeReviewDeterministic("Ruido toda la noche, desayuno escaso y personal maleducado.", "es");
    const order = mentions.map((mention) => REVIEW_CATEGORIES.indexOf(mention.category));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.ok(mentions.length >= 3);
  });
  it("und e it usan la unión es + en", () => {
    assert.equal(resolveDictionaryLanguage("und"), "es+en");
    assert.equal(resolveDictionaryLanguage("it"), "es+en");
    assert.equal(resolveDictionaryLanguage("de"), "de");
    const mixed = byCategory(analyzeReviewDeterministic("Dirty room but friendly staff.", "und"));
    assert.equal(mixed.get("limpieza")?.sentiment, -1);
    assert.equal(mixed.get("personal")?.sentiment, 1);
  });
  it("léxico completo solo para es y en; de/fr/pt reducidos (documentado)", () => {
    assert.deepEqual([...DICTIONARY_FULL_LANGUAGES], ["es", "en"]);
    assert.deepEqual([...DICTIONARY_LANGUAGES], ["es", "en", "de", "fr", "pt"]);
  });
  it("splitClauses separa por puntuación, comas y adversativas", () => {
    assert.deepEqual(splitClauses("Bien, pero caro. ¡Volveremos!"), ["Bien", "caro.", "¡Volveremos!"]);
  });
});

describe("polarityFromMentions", () => {
  const m = (sentiment: -1 | 0 | 1, confidence: number): CategoryMention => ({ category: "limpieza", sentiment, confidence, source: "dictionary" });
  it("null sin menciones", () => assert.equal(polarityFromMentions([]), null));
  it("signo de la suma ponderada", () => {
    assert.equal(polarityFromMentions([m(1, 0.6)]), 1);
    assert.equal(polarityFromMentions([m(-1, 0.9), m(1, 0.4)]), -1);
    assert.equal(polarityFromMentions([m(1, 0.6), m(-1, 0.6)]), 0);
    assert.equal(polarityFromMentions([m(0, 0.4)]), 0);
  });
});

describe("mapPortalSubscores (Booking scoring.*)", () => {
  it("mapea sin NLP con confianza 1 y umbrales 8,5 / 6,0", () => {
    const mentions = byCategory(mapPortalSubscores({ clean: 9.5, staff: 7, location: 5, value: null, facilities: 8.4 }));
    assert.equal(mentions.get("limpieza")?.sentiment, 1);
    assert.equal(mentions.get("personal")?.sentiment, 0);
    assert.equal(mentions.get("ubicacion")?.sentiment, -1);
    assert.equal(mentions.get("instalaciones")?.sentiment, 0);
    assert.equal(mentions.has("precio_valor"), false);
    for (const mention of mentions.values()) {
      assert.equal(mention.confidence, 1);
      assert.equal(mention.source, "portal_subscore");
    }
  });
  it("admite otra escala", () => {
    assert.equal(mapPortalSubscores({ clean: 5 }, 5)[0]?.sentiment, 1);
    assert.deepEqual(mapPortalSubscores(null), []);
  });
  it("mergeMentions: manda la de mayor confianza por categoría", () => {
    const merged = byCategory(mergeMentions(mapPortalSubscores({ clean: 3 }), analyzeReviewDeterministic("Todo muy limpio.", "es")));
    assert.equal(merged.get("limpieza")?.source, "portal_subscore");
    assert.equal(merged.get("limpieza")?.sentiment, -1);
  });
});
