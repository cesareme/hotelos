// Unit tests · Tanda T8 · lote T8-B — respaldo por reglas del puerto de IA
// (reputation-ai.rules.ts + reputation-ai.port.ts): plantillas por tramo e
// idioma, sentimiento por nota y por polaridad, registro singleton. Sin
// base de datos, sin red, sin proveedor de IA. Datos ficticios.
// Desde apps/api:
//   node --import tsx --test src/modules/reputation/__tests__/reputation-ai-rules.test.mts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { CategoryMention } from "../reputation-types.js";
import { getReputationAiPort, resetReputationAiPort, setReputationAiPort, type ReputationAiPort } from "../reputation-ai.port.js";
import { DRAFT_LANGUAGES, DRAFT_MAX_WORDS, RulesReputationAi, buildRulesDraft, bucketFor, countWords, draftLanguageFor } from "../reputation-ai.rules.js";

const ai = new RulesReputationAi();
const HOTEL = "Hotel Ficticio del Norte";

describe("describe()", () => {
  it("es honesto: sin proveedor", () => {
    assert.deepEqual(ai.describe(), { configured: false, provider: "none" });
  });
});

describe("analyzeReview · sentimiento", () => {
  it("la nota manda sobre el texto (score10 ≥ 8,5 → positive aunque el texto sea negativo)", async () => {
    const out = await ai.analyzeReview({ text: "La habitación estaba sucia y el personal fue maleducado.", score10: 9 });
    assert.equal(out.sentiment, "positive");
    assert.equal(out.source, "dictionary");
    assert.equal(out.note, "llm_not_configured");
    assert.equal(out.language, "es");
  });
  it("score10 < 6 → negative; 6-8,49 → neutral", async () => {
    assert.equal((await ai.analyzeReview({ text: "Todo genial.", score10: 4 })).sentiment, "negative");
    assert.equal((await ai.analyzeReview({ text: "Todo genial.", score10: 7 })).sentiment, "neutral");
  });
  it("sin nota, polaridad del diccionario", async () => {
    const positive = await ai.analyzeReview({ text: "El personal fue muy amable y la habitación estaba impecable.", score10: null });
    assert.equal(positive.sentiment, "positive");
    const negative = await ai.analyzeReview({ text: "Habitación sucia y mucho ruido por la noche." });
    assert.equal(negative.sentiment, "negative");
  });
  it("sin nota ni menciones → neutral", async () => {
    const out = await ai.analyzeReview({ text: "Sin más." });
    assert.equal(out.sentiment, "neutral");
    assert.deepEqual(out.categories, []);
  });
  it("respeta el idioma declarado por el portal y detecta si falta", async () => {
    assert.equal((await ai.analyzeReview({ text: "The room was clean and the staff were friendly.", language: "en-GB" })).language, "en");
    assert.equal((await ai.analyzeReview({ text: "The room was clean and the staff were friendly and the breakfast was good." })).language, "en");
  });
  it("enmascara PII antes de analizar: los snippets no llevan el e-mail", async () => {
    const out = await ai.analyzeReview({ text: "El personal fue amable con huesped@ejemplo.test siempre.", title: "Bien" });
    const personal = out.categories.find((mention) => mention.category === "personal");
    assert.ok(personal?.snippet);
    assert.doesNotMatch(personal.snippet, /ejemplo\.test/);
    assert.match(personal.snippet, /\[EMAIL_1\]/);
  });
  it("resumen ≤ 200 caracteres en español", async () => {
    const out = await ai.analyzeReview({ text: "Personal amable, desayuno escaso, wifi lento, ruido, habitación sucia, ubicación perfecta." });
    assert.ok(out.summary && out.summary.length <= 200);
    assert.match(out.summary, /Positivo: .*personal/);
    assert.match(out.summary, /Negativo: .*desayuno/);
  });
  it("las subpuntuaciones del portal mandan sobre el diccionario", async () => {
    const out = await ai.analyzeReview({ text: "Todo muy limpio.", subscores: { clean: 3 } });
    const limpieza = out.categories.find((mention) => mention.category === "limpieza");
    assert.equal(limpieza?.source, "portal_subscore");
    assert.equal(limpieza?.sentiment, -1);
  });
});

describe("draftResponse · plantillas por tramo e idioma", () => {
  const buckets: Array<[number | null, "positive" | "neutral" | "negative"]> = [
    [9.2, "positive"],
    [8.5, "positive"],
    [8.4, "neutral"],
    [6, "neutral"],
    [5.9, "negative"],
    [2, "negative"]
  ];
  const markers: Record<string, Record<"positive" | "neutral" | "negative", RegExp>> = {
    es: { positive: /Nos alegra/, neutral: /Tomamos nota|ayudan a seguir mejorando/, negative: /Lamentamos sinceramente/ },
    en: { positive: /delighted|especially glad/, neutral: /noted/, negative: /sincerely regret/ },
    de: { positive: /freut uns/, neutral: /notiert/, negative: /aufrichtig leid/ },
    fr: { positive: /ravis|heureux/, neutral: /pris note/, negative: /regrettons sincèrement/ },
    pt: { positive: /contentes/, neutral: /Tomámos nota|nota dos pontos/, negative: /Lamentamos sinceramente/ }
  };
  for (const language of DRAFT_LANGUAGES) {
    for (const [score10, bucket] of buckets) {
      it(`[${language}] nota ${score10} → tramo ${bucket}, ≤ ${DRAFT_MAX_WORDS} palabras, firma`, async () => {
        const out = await ai.draftResponse({ score10, sentiment: "neutral", language, categories: [], hotelName: HOTEL });
        assert.equal(out.source, "rules");
        assert.equal(out.language, language);
        assert.match(out.body, markers[language]![bucket]);
        assert.ok(countWords(out.body) <= DRAFT_MAX_WORDS, `${countWords(out.body)} palabras`);
        assert.ok(out.body.endsWith(`Dirección de ${HOTEL}`), out.body);
        assert.doesNotMatch(out.body, /\d/, "sin cifras: ni habitación, ni fechas, ni importes");
      });
    }
  }
  it("negativa: disculpa + canal privado + invitación (es)", async () => {
    const out = await ai.draftResponse({ score10: 3, sentiment: "negative", language: "es", categories: [], hotelName: HOTEL });
    assert.match(out.body, /Lamentamos/);
    assert.match(out.body, /escribirnos directamente al hotel/);
    assert.match(out.body, /próxima ocasión/);
  });
  it("menciona hasta dos categorías negativas en el idioma del borrador", async () => {
    const categories: CategoryMention[] = [
      { category: "limpieza", sentiment: -1, confidence: 0.8, source: "dictionary" },
      { category: "ruido", sentiment: -1, confidence: 0.7, source: "dictionary" },
      { category: "wifi", sentiment: -1, confidence: 0.6, source: "dictionary" },
      { category: "personal", sentiment: 1, confidence: 0.9, source: "dictionary" }
    ];
    const es = await ai.draftResponse({ score10: 4, sentiment: "negative", language: "es", categories, hotelName: HOTEL });
    assert.match(es.body, /limpieza y ruido/);
    assert.doesNotMatch(es.body, /wifi/i);
    const en = await ai.draftResponse({ score10: 4, sentiment: "negative", language: "en", categories, hotelName: HOTEL });
    assert.match(en.body, /cleanliness and noise/);
    const positive = await ai.draftResponse({ score10: 9, sentiment: "positive", language: "es", categories, hotelName: HOTEL });
    assert.match(positive.body, /destaque personal/);
  });
  it("sin nota usa el sentimiento; und e it caen a español; tono cercano", async () => {
    const bySentiment = await ai.draftResponse({ score10: null, sentiment: "negative", language: "und", categories: [], hotelName: HOTEL });
    assert.equal(bySentiment.language, "es");
    assert.match(bySentiment.body, /Lamentamos/);
    assert.equal(draftLanguageFor("it"), "es");
    assert.equal(bucketFor(null, "positive"), "positive");
    assert.equal(bucketFor(7.5, "positive"), "neutral");
    const close = buildRulesDraft({ score10: 9, sentiment: "positive", language: "es", categories: [], hotelName: HOTEL, tone: "cercano" });
    assert.ok(close.body.startsWith("Hola:"));
    const formal = buildRulesDraft({ score10: 9, sentiment: "positive", language: "es", categories: [], hotelName: HOTEL });
    assert.ok(formal.body.startsWith("Estimado huésped:"));
  });
  it("firma alternativa y hotel vacío", async () => {
    const out = await ai.draftResponse({ score10: 9, sentiment: "positive", language: "en", categories: [], hotelName: "Hotel Ficticio", signature: "Equipo de Hotel Ficticio" });
    assert.ok(out.body.endsWith("Equipo de Hotel Ficticio"));
    const empty = await ai.draftResponse({ score10: 9, sentiment: "positive", language: "es", categories: [], hotelName: "  " });
    assert.ok(empty.body.endsWith("Dirección de nuestro hotel"));
  });
  it("nunca copia el texto de la reseña ni datos de la estancia", async () => {
    const out = await ai.draftResponse({ score10: 3, sentiment: "negative", language: "es", categories: [], hotelName: HOTEL, title: "Habitación 432 sucia", body: "Pagamos 180 euros el 12/08 y la habitación 432 olía mal." });
    assert.doesNotMatch(out.body, /432|180|12\/08|olía/);
  });
});

describe("registro singleton del puerto", () => {
  afterEach(() => resetReputationAiPort());
  it("por defecto devuelve el respaldo por reglas", () => {
    assert.ok(getReputationAiPort() instanceof RulesReputationAi);
    assert.equal(getReputationAiPort(), getReputationAiPort());
  });
  it("setReputationAiPort sustituye la implementación (enganche de L6a) y null la retira", async () => {
    const fake: ReputationAiPort = {
      describe: () => ({ configured: true, provider: "prueba", model: "modelo-ficticio" }),
      analyzeReview: async () => ({ language: "es", sentiment: "positive", categories: [], source: "llm" }),
      draftResponse: async () => ({ body: "hola", source: "ai", model: "modelo-ficticio", language: "es" })
    };
    setReputationAiPort(fake);
    assert.equal(getReputationAiPort().describe().provider, "prueba");
    assert.equal((await getReputationAiPort().draftResponse({ score10: 9, sentiment: "positive", language: "es", categories: [], hotelName: HOTEL })).source, "ai");
    setReputationAiPort(null);
    assert.equal(getReputationAiPort().describe().provider, "none");
  });
});
