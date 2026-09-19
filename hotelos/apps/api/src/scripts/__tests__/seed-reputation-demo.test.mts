// Reputación · Tanda T8 · lote T8-H — tests puros del dataset de demo con
// reseñas FICTICIAS. Sin base de datos: importa SOLO seed-reputation-demo.dataset.ts
// (determinismo, ausencia de nombres reales y URLs, distribución por tramo,
// marcado isDemo, plan de purga y la guarda demo con entorno explícito).
//   cd apps/api && node --import tsx --test src/scripts/__tests__/seed-reputation-demo.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEMO_AUTHOR_PATTERN,
  DEMO_DEFAULT_REVIEWS,
  DEMO_DISTRIBUTION,
  DEMO_GOOGLE_MAX_AGE_DAYS,
  DEMO_LANGUAGES,
  DEMO_REVIEWS_MAX,
  DEMO_REVIEWS_MIN,
  DEMO_SCORE_THRESHOLDS,
  DEMO_SOURCE_SPECS,
  DEMO_SURVEY_RESPONSES,
  DEMO_SURVEY_SUFFIX,
  DEMO_SURVEYS,
  buildPurgePlan,
  buildReputationDemoDataset,
  buildSeedPlan,
  bucketOfScore,
  createPrng,
  decideSeedTarget,
  demoAuthorFor,
  demoReferencePrefix,
  explainSeedTargets,
  guardEnvFromFlags
} from "../seed-reputation-demo.dataset.js";

const NOW = new Date("2026-09-19T10:00:00.000Z");
const DAY = 86_400_000;
const FARANDA_ORG = "cmrhw9jy30002fyvb6tsdiugt";
const RIAS_ALTAS = "cmrhw9jy40003fyvbuu2ec2w7";
const LOS_TILOS = "cmu1mifcp0000fyo1wzvq7txo";
const URL_PATTERN = /https?:\/\/|www\.|\.(com|es|net|org)\b/i;
const EMAIL_PATTERN = /@/;

function build(overrides: Partial<Parameters<typeof buildReputationDemoDataset>[0]> = {}) {
  return buildReputationDemoDataset({ propertyId: "prop_123", hotelName: "Hotel Demo Madrid Centro", now: NOW, seed: 42, ...overrides });
}

describe("createPrng (mulberry32)", () => {
  it("es determinista por semilla y devuelve valores en [0, 1)", () => {
    const a = createPrng(42);
    const b = createPrng(42);
    const c = createPrng(43);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    const seqC = Array.from({ length: 20 }, () => c());
    assert.deepEqual(seqA, seqB);
    assert.notDeepEqual(seqA, seqC);
    for (const value of seqA) assert.ok(value >= 0 && value < 1, `valor fuera de [0,1): ${value}`);
  });
});

describe("buildReputationDemoDataset · determinismo", () => {
  it("dos llamadas con seed 42 devuelven estructuras idénticas", () => {
    assert.deepEqual(build(), build());
  });

  it("otra semilla cambia las referencias externas y el contenido", () => {
    const a = build({ seed: 42 });
    const b = build({ seed: 7 });
    assert.equal(a.reviews[0]?.externalReference, "demo:42:1");
    assert.equal(b.reviews[0]?.externalReference, "demo:7:1");
    assert.notDeepEqual(a.reviews.map((r) => r.item.body), b.reviews.map((r) => r.item.body));
  });

  it("respeta los valores por defecto y los límites de reviews/days", () => {
    const dataset = build();
    assert.equal(dataset.reviews.length, DEMO_DEFAULT_REVIEWS);
    assert.ok(DEMO_DEFAULT_REVIEWS >= DEMO_REVIEWS_MIN && DEMO_DEFAULT_REVIEWS <= DEMO_REVIEWS_MAX);
    assert.equal(build({ reviews: DEMO_REVIEWS_MIN }).reviews.length, DEMO_REVIEWS_MIN);
    assert.equal(build({ reviews: DEMO_REVIEWS_MAX }).reviews.length, DEMO_REVIEWS_MAX);
    assert.throws(() => build({ reviews: DEMO_REVIEWS_MIN - 1 }));
    assert.throws(() => build({ reviews: DEMO_REVIEWS_MAX + 1 }));
    assert.throws(() => build({ days: 0 }));
    assert.throws(() => buildReputationDemoDataset({ propertyId: "" }));
  });
});

describe("buildReputationDemoDataset · datos ficticios (0 nombres reales, 0 URLs)", () => {
  const dataset = build();

  it("todo autor cumple «Huésped A.»…«Huésped Z.» o «Viajero N»", () => {
    for (const review of dataset.reviews) {
      assert.match(review.item.authorDisplayName ?? "", DEMO_AUTHOR_PATTERN, `autor no permitido en ${review.externalReference}: ${review.item.authorDisplayName}`);
    }
    assert.equal(demoAuthorFor(2), "Huésped B.");
    assert.equal(demoAuthorFor(3), "Viajero 3");
    assert.equal(demoAuthorFor(48), "Huésped A.");
    // E e Y son partículas para minimizeAuthorName (review-normalize.ts): nunca se usan como inicial.
    for (const review of dataset.reviews) assert.doesNotMatch(review.item.authorDisplayName ?? "", /^Huésped [EY]\.$/);
  });

  it("no hay URLs ni correos en títulos, cuerpos ni respuestas; portalUrl ausente", () => {
    for (const review of dataset.reviews) {
      const texts = [review.item.title ?? "", review.item.body ?? "", review.item.portalReply?.body ?? ""];
      for (const text of texts) {
        assert.doesNotMatch(text, URL_PATTERN, `URL en ${review.externalReference}: ${text}`);
        assert.doesNotMatch(text, EMAIL_PATTERN, `correo en ${review.externalReference}: ${text}`);
      }
      assert.equal(review.item.portalUrl, undefined);
      assert.equal(review.item.externalId, undefined, "la referencia externa la fuerza el seed (demo:<seed>:<n>)");
    }
    for (const survey of dataset.surveys) {
      for (const response of survey.responses) assert.doesNotMatch(response.answers.comment, URL_PATTERN);
    }
  });

  it("externalReference es demo:<seed>:<n> y única", () => {
    const refs = dataset.reviews.map((review) => review.externalReference);
    assert.equal(new Set(refs).size, refs.length);
    refs.forEach((ref, index) => assert.equal(ref, `${demoReferencePrefix(42)}${index + 1}`));
  });

  it("idiomas es/en/de, países ficticios y cuerpos con categorías mencionadas", () => {
    for (const review of dataset.reviews) {
      assert.ok((DEMO_LANGUAGES as readonly string[]).includes(review.language));
      assert.equal(review.item.language, review.language);
      assert.match(review.item.authorCountry ?? "", /^[A-Z]{2}$/);
      assert.ok(review.categories.length >= 2, `sin categorías en ${review.externalReference}`);
      assert.ok((review.item.body ?? "").length > 20);
      assert.ok((review.item.title ?? "").length > 3);
      assert.equal(review.item.bodyComplete, true);
      assert.equal(review.item.replyCapability, false);
    }
    assert.ok(dataset.stats.byLanguage.es > dataset.stats.byLanguage.en);
    assert.ok(dataset.stats.byLanguage.de > 0);
  });
});

describe("buildReputationDemoDataset · distribución y fechas", () => {
  const dataset = build();

  it("65 % ≥ 8,5 · 25 % neutras · 10 % < 6 (±10 puntos) y tramo coherente con la nota", () => {
    const { shares } = dataset.stats;
    assert.ok(Math.abs(shares.positive - DEMO_DISTRIBUTION.positive) <= 0.1, `positivas ${shares.positive}`);
    assert.ok(Math.abs(shares.neutral - DEMO_DISTRIBUTION.neutral) <= 0.1, `neutras ${shares.neutral}`);
    assert.ok(Math.abs(shares.negative - DEMO_DISTRIBUTION.negative) <= 0.1, `negativas ${shares.negative}`);
    assert.equal(dataset.stats.positive + dataset.stats.neutral + dataset.stats.negative, dataset.reviews.length);
    for (const review of dataset.reviews) {
      assert.equal(bucketOfScore(review.score10), review.bucket, `tramo incoherente en ${review.externalReference}: ${review.score10}`);
      if (review.bucket === "positive") assert.ok(review.score10 >= DEMO_SCORE_THRESHOLDS.positive);
      if (review.bucket === "negative") assert.ok(review.score10 < DEMO_SCORE_THRESHOLDS.negative);
      const { ratingRaw, ratingScaleMax } = review.item;
      assert.ok(typeof ratingRaw === "number" && ratingRaw >= 0 && ratingRaw <= (ratingScaleMax as number));
      assert.equal(ratingScaleMax, review.provider === "booking" ? 10 : 5);
      if (review.provider === "google") assert.equal(Number.isInteger(ratingRaw), true, "Google publica estrellas enteras");
    }
  });

  it("tres portales presentes, todos con source <p>_demo y modo de su fuente", () => {
    const codes = new Set(dataset.reviews.map((review) => review.source));
    assert.deepEqual([...codes].sort(), ["booking_demo", "csv_demo", "google_demo"]);
    for (const review of dataset.reviews) {
      const spec = DEMO_SOURCE_SPECS.find((entry) => entry.provider === review.provider);
      assert.ok(spec);
      assert.equal(review.source, spec.code);
      assert.equal(review.sourceMode, spec.mode);
    }
  });

  it("receivedAt cae en la ventana --days y Google nunca supera 30 días (retención)", () => {
    const days = 180;
    for (const review of dataset.reviews) {
      const age = (NOW.getTime() - Date.parse(review.item.receivedAt)) / DAY;
      assert.ok(age >= 1 && age <= days, `edad fuera de ventana en ${review.externalReference}: ${age}`);
      if (review.provider === "google") assert.ok(age <= DEMO_GOOGLE_MAX_AGE_DAYS, `google_demo con ${age} días`);
    }
    const short = build({ days: 10 });
    for (const review of short.reviews) assert.ok((NOW.getTime() - Date.parse(review.item.receivedAt)) / DAY <= 10);
  });

  it("40 % respondidas (±10 puntos) con la plantilla por reglas, después de recibirse y antes de ahora", () => {
    assert.ok(Math.abs(dataset.stats.shares.responded - DEMO_DISTRIBUTION.responded) <= 0.1);
    for (const review of dataset.reviews) {
      if (!review.responded) {
        assert.equal(review.item.portalReply, undefined);
        continue;
      }
      const reply = review.item.portalReply;
      assert.ok(reply, `sin respuesta en ${review.externalReference}`);
      assert.ok(reply.body.length > 40);
      assert.ok(reply.body.includes("Hotel Demo Madrid Centro"), "la firma lleva el nombre del hotel");
      const repliedAt = Date.parse(reply.repliedAt ?? "");
      assert.ok(repliedAt > Date.parse(review.item.receivedAt));
      assert.ok(repliedAt < NOW.getTime());
    }
  });
});

describe("buildReputationDemoDataset · marcado isDemo y encuestas", () => {
  const dataset = build();

  it("las tres fuentes están marcadas isDemo con estados honestos", () => {
    assert.equal(dataset.sources.length, 3);
    for (const source of dataset.sources) {
      assert.equal(source.isDemo, true);
      assert.ok(source.code.endsWith("_demo"));
      assert.ok(source.displayName.includes("(demo)"));
    }
    assert.deepEqual(
      dataset.sources.map((source) => [source.provider, source.mode, source.expectedStatus]),
      [
        ["google", "api", "unavailable"],
        ["booking", "api", "unavailable"],
        ["csv", "csv", "connected"]
      ]
    );
  });

  it("todas las reseñas llevan isDemo", () => {
    for (const review of dataset.reviews) assert.equal(review.isDemo, true);
  });

  it("2 encuestas «(demo)» con 30 respuestas score 0-10 marcadas isDemo y con demoRef único", () => {
    assert.equal(dataset.surveys.length, DEMO_SURVEYS);
    const refs: string[] = [];
    let total = 0;
    for (const survey of dataset.surveys) {
      assert.ok(survey.name.endsWith(DEMO_SURVEY_SUFFIX), survey.name);
      assert.equal(survey.isDemo, true);
      assert.equal(survey.surveyType, "post_stay");
      assert.ok(survey.questions.length >= 3);
      for (const response of survey.responses) {
        total += 1;
        refs.push(response.demoRef);
        assert.ok(Number.isInteger(response.score) && response.score >= 0 && response.score <= 10);
        assert.equal(response.answers.isDemo, true);
        assert.equal(response.answers.demoRef, response.demoRef);
        assert.equal(response.answers.nps, response.score);
        const age = (NOW.getTime() - Date.parse(response.createdAt)) / DAY;
        assert.ok(age >= 1 && age <= 90);
      }
    }
    assert.equal(total, DEMO_SURVEY_RESPONSES);
    assert.equal(dataset.stats.surveyResponses, DEMO_SURVEY_RESPONSES);
    assert.equal(new Set(refs).size, refs.length);
    const promoters = dataset.surveys.flatMap((s) => s.responses).filter((r) => r.score >= 9).length;
    assert.ok(promoters / total >= 0.4, "distribución NPS realista: mayoría de promotores");
  });
});

describe("planes de escritura", () => {
  it("el plan de purga solo contiene deleteMany con filtro isDemo, acotados a la propiedad", () => {
    const plan = buildPurgePlan({ propertyId: "prop_123", counts: { guest_reviews: 90, review_sources: 3 } });
    assert.equal(plan.length, 5);
    assert.deepEqual(
      plan.map((write) => write.table),
      ["quality_cases", "survey_responses", "surveys", "guest_reviews", "review_sources"]
    );
    for (const write of plan) {
      assert.equal(write.op, "deleteMany");
      assert.ok(write.where?.includes("isDemo"), `sin filtro isDemo: ${write.table}`);
      assert.ok(write.where?.includes("prop_123"), `sin propiedad: ${write.table}`);
    }
    assert.equal(plan.find((write) => write.table === "guest_reviews")?.count, 90);
    assert.equal(plan.find((write) => write.table === "quality_cases")?.count, undefined);
  });

  it("el plan de siembra marca isDemo en cada escritura y no abre casos con el módulo apagado", () => {
    const dataset = build();
    const on = buildSeedPlan(dataset, true);
    const off = buildSeedPlan(dataset, false);
    for (const write of [...on, ...off]) assert.ok(write.where?.includes("isDemo"), `sin marca isDemo: ${write.table}`);
    assert.equal(on.find((write) => write.table === "guest_reviews")?.count, dataset.reviews.length);
    assert.equal(on.find((write) => write.table === "quality_cases")?.count, dataset.stats.negative);
    assert.equal(off.find((write) => write.table === "quality_cases")?.count, 0);
    assert.ok(on.every((write) => write.op !== "deleteMany"));
  });
});

describe("guarda demo con entorno explícito (SEED_ALLOW_REAL / SEED_CONFIRM sin leer el proceso)", () => {
  it("guardEnvFromFlags conserva la semántica de las dos variables", () => {
    assert.deepEqual(guardEnvFromFlags({ allowReal: false, confirm: [] }), { SEED_ALLOW_REAL: undefined, SEED_CONFIRM: undefined });
    assert.deepEqual(guardEnvFromFlags({ allowReal: true, confirm: [RIAS_ALTAS, ` ${FARANDA_ORG} `] }), { SEED_ALLOW_REAL: "1", SEED_CONFIRM: `${RIAS_ALTAS},${FARANDA_ORG}` });
  });

  it("prop_123 (org_123) → allowlist sin flags", () => {
    assert.equal(decideSeedTarget({ propertyIds: ["prop_123"], orgIds: ["org_123"], allowReal: false, confirm: [] }), "allowlist");
    assert.equal(decideSeedTarget({ propertyIds: ["prop_canary"], orgIds: ["org_123"], allowReal: false, confirm: [] }), "allowlist");
  });

  it("propiedad fuera de la allowlist sin --allow-real/--confirm → refused (con motivo)", () => {
    const [explanation] = explainSeedTargets({ propertyIds: [RIAS_ALTAS], orgIds: [FARANDA_ORG], allowReal: false, confirm: [] });
    assert.equal(explanation?.decision, "refused");
    assert.match(explanation?.reason ?? "", /SEED_ALLOW_REAL/);
    assert.equal(decideSeedTarget({ propertyIds: [RIAS_ALTAS], orgIds: [FARANDA_ORG], allowReal: true, confirm: [] }), "refused");
    assert.equal(decideSeedTarget({ propertyIds: [RIAS_ALTAS], orgIds: [FARANDA_ORG], allowReal: false, confirm: [RIAS_ALTAS] }), "refused");
    assert.equal(decideSeedTarget({ propertyIds: [RIAS_ALTAS], orgIds: [FARANDA_ORG], allowReal: true, confirm: [LOS_TILOS] }), "refused");
  });

  it("con --allow-real y --confirm <propertyId> o <organizationId> → confirmed", () => {
    assert.equal(decideSeedTarget({ propertyIds: [RIAS_ALTAS], orgIds: [FARANDA_ORG], allowReal: true, confirm: [RIAS_ALTAS] }), "confirmed");
    assert.equal(decideSeedTarget({ propertyIds: [RIAS_ALTAS, LOS_TILOS], orgIds: [FARANDA_ORG, FARANDA_ORG], allowReal: true, confirm: [FARANDA_ORG] }), "confirmed");
    assert.equal(decideSeedTarget({ propertyIds: [RIAS_ALTAS, LOS_TILOS], orgIds: [FARANDA_ORG, FARANDA_ORG], allowReal: true, confirm: [RIAS_ALTAS] }), "refused", "Los Tilos sin confirmar");
  });

  it("mezcla allowlist + confirmada → confirmed; lista vacía → refused", () => {
    assert.equal(decideSeedTarget({ propertyIds: ["prop_123", RIAS_ALTAS], orgIds: ["org_123", FARANDA_ORG], allowReal: true, confirm: [RIAS_ALTAS] }), "confirmed");
    assert.equal(decideSeedTarget({ propertyIds: [], orgIds: [], allowReal: true, confirm: [] }), "refused");
  });

  it("una propiedad no demo dentro de org_123 no se cuela por la organización", () => {
    assert.equal(decideSeedTarget({ propertyIds: ["prop_nueva"], orgIds: ["org_123"], allowReal: true, confirm: ["org_123"] }), "refused");
    assert.equal(decideSeedTarget({ propertyIds: ["prop_nueva"], orgIds: ["org_123"], allowReal: true, confirm: ["prop_nueva"] }), "confirmed");
  });
});
