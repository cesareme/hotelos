// Reputación · Tanda T8 · lote T8-H — dataset de demo con reseñas FICTICIAS
// (apps/api/src/scripts/seed-reputation-demo.dataset.ts).
//
// Módulo PURO: sin Prisma, sin lecturas de entorno, sin red. Construye de forma
// DETERMINISTA (PRNG mulberry32 sembrado con `seed`) todo lo que el CLI
// seed-reputation-demo.ts escribe sobre las tablas EXISTENTES
// (schema.prisma:1876-1957, sin el parche T8-L0):
//   · 3 fuentes por propiedad: google modo `api` → estado `unavailable` («sin
//     credenciales»), booking modo `api` → `unavailable` («solo connectivity
//     partners»), csv modo `csv` → `connected`; todas con configJson.isDemo y
//     provider `<p>_demo` (providerCodeFor de review-sources.service.ts);
//   · N reseñas (60-120; 90 por defecto) con source ∈ {google_demo,
//     booking_demo, csv_demo}, escalas 5 (google: estrellas enteras; csv: medias
//     estrellas) y 10 (booking: un decimal), distribución 65 % ≥ 8,5 · 25 %
//     neutras · 10 % < 6 (tramos de sentimentBucket), receivedAt repartido en
//     la ventana `days` (Google ≤ 30 días: retención del portal, así el tick no
//     purga sus cuerpos), idiomas es/en/de, títulos y cuerpos INVENTADOS a
//     partir de fragmentos por categoría (con términos del diccionario para
//     que el análisis etiquete), autores solo «Huésped A.»…«Huésped Z.» o
//     «Viajero N» (sin apellidos), sin URLs (portalUrl ausente),
//     externalReference `demo:<seed>:<n>`, meta isDemo; 40 % ya respondidas
//     con la plantilla de RulesReputationAi (buildRulesDraft) como portalReply;
//   · 2 encuestas «… (demo)» (post_stay) con 30 respuestas de score 0-10 y
//     distribución NPS realista, responsesJson.isDemo + demoRef;
//   · decideSeedTarget: envoltorio puro de evaluateDemoTarget (demo-guard.ts)
//     que conserva la semántica SEED_ALLOW_REAL / SEED_CONFIRM sin leer el
//     entorno del proceso (guardEnvFromFlags construye el objeto explícito);
//   · buildPurgePlan / buildSeedPlan: PlannedWrite[] SOLO con filtros isDemo.
//
// Tests: cd apps/api && node --import tsx --test src/scripts/__tests__/seed-reputation-demo.test.mts

import { z } from "zod";
import { evaluateDemoTarget, type DemoGuardEnv, type PlannedWrite } from "../../../../packages/database/prisma/lib/demo-guard.js";
import type { NormalizedReview } from "../modules/reputation/collectors/types.js";
import { buildRulesDraft } from "../modules/reputation/reputation-ai.rules.js";
import { REVIEW_CATEGORIES, SCORE10_NEGATIVE, SCORE10_POSITIVE, sentimentBucket, type ReviewCategory, type ReviewSourceMode, type Sentiment } from "../modules/reputation/reputation-types.js";
import { analyzeReviewDeterministic } from "../modules/reputation/review-categories.dictionary.js";

// ---------------------------------------------------------------------------
// Constantes públicas
// ---------------------------------------------------------------------------

export const DEMO_PROVIDERS = Object.freeze(["google", "booking", "csv"] as const);
export type DemoProvider = (typeof DEMO_PROVIDERS)[number];

export const DEMO_LANGUAGES = Object.freeze(["es", "en", "de"] as const);
export type DemoLanguage = (typeof DEMO_LANGUAGES)[number];

/** Sufijo que marca las encuestas demo (la purga filtra por nombre). */
export const DEMO_SURVEY_SUFFIX = "(demo)";
/** Prefijo de externalReference de todas las reseñas demo: `demo:<seed>:<n>`. */
export const DEMO_REFERENCE_PREFIX = "demo:";
/** Autores permitidos: «Huésped A.»…«Huésped Z.» o «Viajero N». */
export const DEMO_AUTHOR_PATTERN = /^(Huésped [A-Z]\.|Viajero \d+)$/;
/** Retención de Google (días): las reseñas google_demo nunca son más antiguas. */
export const DEMO_GOOGLE_MAX_AGE_DAYS = 30;

export const DEMO_DEFAULT_DAYS = 180;
export const DEMO_DEFAULT_REVIEWS = 90;
export const DEMO_DEFAULT_SEED = 42;
export const DEMO_REVIEWS_MIN = 60;
export const DEMO_REVIEWS_MAX = 120;
export const DEMO_DAYS_MIN = 1;
export const DEMO_DAYS_MAX = 730;
export const DEMO_SURVEYS = 2;
export const DEMO_SURVEY_RESPONSES = 30;

/** Cuotas de la distribución (fracciones del total de reseñas). */
export const DEMO_DISTRIBUTION = Object.freeze({ positive: 0.65, neutral: 0.25, negative: 0.1, responded: 0.4 });
/** Pesos de reparto por portal e idioma (deterministas por PRNG). */
export const DEMO_PROVIDER_WEIGHTS: Readonly<Record<DemoProvider, number>> = Object.freeze({ google: 0.4, booking: 0.35, csv: 0.25 });
export const DEMO_LANGUAGE_WEIGHTS: Readonly<Record<DemoLanguage, number>> = Object.freeze({ es: 0.6, en: 0.25, de: 0.15 });

export type DemoSourceSpec = {
  provider: DemoProvider;
  /** Código guardado en ReviewSource.provider y GuestReview.source. */
  code: `${DemoProvider}_demo`;
  mode: ReviewSourceMode;
  displayName: string;
  /** Estado honesto que fijará createReviewSource sin credenciales. */
  expectedStatus: "unavailable" | "connected";
  expectedReason: string;
  isDemo: true;
};

export const DEMO_SOURCE_SPECS: readonly DemoSourceSpec[] = Object.freeze([
  { provider: "google", code: "google_demo", mode: "api", displayName: "Google (demo)", expectedStatus: "unavailable", expectedReason: "sin credenciales (GOOGLE_BUSINESS_CLIENT_ID)", isDemo: true },
  { provider: "booking", code: "booking_demo", mode: "api", displayName: "Booking.com (demo)", expectedStatus: "unavailable", expectedReason: "solo connectivity partners", isDemo: true },
  { provider: "csv", code: "csv_demo", mode: "csv", displayName: "Importación CSV (demo)", expectedStatus: "connected", expectedReason: "importación manual", isDemo: true }
]);

// ---------------------------------------------------------------------------
// Opciones (zod) y PRNG determinista
// ---------------------------------------------------------------------------

export const DEMO_DATASET_OPTIONS_SCHEMA = z
  .object({
    propertyId: z.string().trim().min(1, "propertyId no puede estar vacío.").max(64),
    hotelName: z.string().trim().min(1).max(200).optional(),
    now: z.date().optional(),
    days: z.number().int().min(DEMO_DAYS_MIN).max(DEMO_DAYS_MAX).optional(),
    reviews: z.number().int().min(DEMO_REVIEWS_MIN, `reviews mínimo ${DEMO_REVIEWS_MIN}.`).max(DEMO_REVIEWS_MAX, `reviews máximo ${DEMO_REVIEWS_MAX}.`).optional(),
    seed: z.number().int().min(0).max(2_147_483_647).optional()
  })
  .strict();

export type DemoDatasetOptions = z.input<typeof DEMO_DATASET_OPTIONS_SCHEMA>;

/** mulberry32: PRNG de 32 bits, determinista por semilla, en [0, 1). */
export function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Prng = () => number;

function pick<T>(prng: Prng, list: readonly T[]): T {
  const index = Math.min(list.length - 1, Math.floor(prng() * list.length));
  return list[index] as T;
}

function pickWeighted<K extends string>(prng: Prng, weights: Readonly<Record<K, number>>): K {
  const entries = Object.entries(weights) as Array<[K, number]>;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let cursor = prng() * total;
  for (const [key, weight] of entries) {
    cursor -= weight;
    if (cursor < 0) return key;
  }
  return (entries[entries.length - 1] as [K, number])[0];
}

function shuffle<T>(prng: Prng, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(prng() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

function pickDistinct<T>(prng: Prng, list: readonly T[], count: number): T[] {
  return shuffle(prng, list).slice(0, Math.max(0, Math.min(count, list.length)));
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// Plantillas INVENTADAS: fragmentos por idioma, categoría y polaridad
// ---------------------------------------------------------------------------

type Fragment = { positive: string; negative: string };
type LanguageTemplates = {
  fragments: Readonly<Record<ReviewCategory, Fragment>>;
  titles: Readonly<Record<Sentiment, readonly string[]>>;
  closers: Readonly<Record<Sentiment, readonly string[]>>;
  contrast: string;
};

const ES_TEMPLATES: LanguageTemplates = {
  fragments: {
    limpieza: { positive: "La limpieza era impecable, con sábanas y toallas relucientes", negative: "La limpieza dejaba mucho que desear: polvo en los muebles y el baño sucio" },
    habitacion: { positive: "La habitación era amplia, luminosa y muy cómoda, con una cama estupenda", negative: "La habitación era diminuta y el colchón muy incómodo" },
    personal: { positive: "El personal fue amable y atento en todo momento", negative: "El personal de recepción fue bastante desagradable y poco profesional" },
    desayuno: { positive: "El desayuno, variado y abundante, con buena bollería y zumo natural", negative: "El desayuno era escaso y repetitivo, con poca variedad" },
    restauracion: { positive: "La cena en el restaurante fue deliciosa y la carta muy cuidada", negative: "La comida del restaurante resultó insípida y llegó recalentada" },
    ubicacion: { positive: "Ubicación inmejorable, céntrica y con todo a dos pasos", negative: "La ubicación está bastante alejada y mal comunicada con el centro" },
    precio_valor: { positive: "Buena relación calidad precio; merece la pena", negative: "El precio nos pareció excesivo para lo que ofrece; no vale lo que cobran" },
    instalaciones: { positive: "Instalaciones modernas y cuidadas, con una piscina y un jardín preciosos", negative: "Las instalaciones están anticuadas y la piscina cerrada por obras" },
    ruido: { positive: "Habitación silenciosa y bien insonorizada: descansamos bien", negative: "Mucho ruido por la noche; las paredes son de papel y no pudimos dormir" },
    wifi: { positive: "El wifi funcionaba bien, rápido y estable en toda la planta", negative: "El wifi era lentísimo y se cortaba constantemente" },
    recepcion_checkin: { positive: "El check in fue ágil y sin esperas, con las llaves listas en un minuto", negative: "Una hora esperando en recepción para el check in; un caos" },
    mantenimiento: { positive: "Todo funcionaba correctamente y las instalaciones estaban en buen estado", negative: "El grifo de la ducha goteaba y el aire acondicionado no funcionaba" }
  },
  titles: {
    positive: ["Una estancia estupenda", "Repetiremos sin duda", "Todo perfecto", "Muy recomendable", "Excelente en todo"],
    neutral: ["Correcto, con matices", "Bien, pero mejorable", "Estancia normal", "Aceptable"],
    negative: ["Decepcionante", "No volveremos", "Muy por debajo de lo esperado", "Mal en varios aspectos"]
  },
  closers: {
    positive: ["Repetiremos sin duda", "Muy recomendable", "Volveremos seguro"],
    neutral: ["En general, correcto", "Estancia correcta con margen de mejora"],
    negative: ["No lo recomiendo", "No volveremos", "Una decepción"]
  },
  contrast: "Pero"
};

const EN_TEMPLATES: LanguageTemplates = {
  fragments: {
    limpieza: { positive: "The room was spotless and housekeeping came every day", negative: "Cleanliness was poor: dusty surfaces and a dirty bathroom" },
    habitacion: { positive: "The room was spacious, bright and very comfortable", negative: "The room was tiny and the mattress uncomfortable" },
    personal: { positive: "The staff were friendly and helpful throughout", negative: "The front desk staff were rude and unhelpful" },
    desayuno: { positive: "Breakfast was plentiful and varied, with fresh pastries", negative: "Breakfast was limited and repetitive, with little choice" },
    restauracion: { positive: "Dinner at the restaurant was delicious and the menu well chosen", negative: "The restaurant food was bland and arrived reheated" },
    ubicacion: { positive: "Great location, central and within walking distance of everything", negative: "The location is remote and poorly connected to the centre" },
    precio_valor: { positive: "Good value for money; worth it", negative: "Overpriced for what you get; not worth the money" },
    instalaciones: { positive: "Modern, well maintained facilities with a lovely pool and garden", negative: "The facilities are run down and the pool was closed" },
    ruido: { positive: "Quiet room with good soundproofing: we slept well", negative: "Very noisy at night; thin walls and we could not sleep" },
    wifi: { positive: "The wifi worked well, fast and reliable on every floor", negative: "The wifi was slow and kept dropping" },
    recepcion_checkin: { positive: "Check in was quick and smooth, no wait at all", negative: "We waited an hour at reception for check in; chaotic" },
    mantenimiento: { positive: "Everything worked and the property is in great condition", negative: "The shower tap was leaking and the air conditioning was not working" }
  },
  titles: {
    positive: ["Wonderful stay", "Will come back", "Spot on", "Highly recommended"],
    neutral: ["Decent, with some issues", "Fine but could be better", "Average stay"],
    negative: ["Disappointing", "Not what we expected", "Never again"]
  },
  closers: {
    positive: ["We will be back", "Highly recommended"],
    neutral: ["Overall fine", "Decent stay with room for improvement"],
    negative: ["Would not recommend", "Never again"]
  },
  contrast: "But"
};

const DE_TEMPLATES: LanguageTemplates = {
  fragments: {
    limpieza: { positive: "Das Zimmer war blitzsauber und die Reinigung erfolgte täglich", negative: "Die Sauberkeit ließ zu wünschen übrig: Staub überall und das Bad war schmutzig" },
    habitacion: { positive: "Das Zimmer war geräumig, hell und sehr bequem", negative: "Das Zimmer war winzig und die Matratze unbequem" },
    personal: { positive: "Das Personal war freundlich und hilfsbereit", negative: "Das Personal an der Rezeption war unfreundlich und desinteressiert" },
    desayuno: { positive: "Das Frühstück war reichhaltig und vielfältig", negative: "Das Frühstück war dürftig und eintönig" },
    restauracion: { positive: "Das Abendessen im Restaurant war lecker und köstlich", negative: "Das Essen im Restaurant war fade und aufgewärmt" },
    ubicacion: { positive: "Perfekte Lage, zentral und alles in der Nähe", negative: "Die Lage ist abgelegen und ungünstig" },
    precio_valor: { positive: "Das Preis-Leistungs-Verhältnis ist fair", negative: "Viel zu teuer für das Gebotene" },
    instalaciones: { positive: "Die Anlage mit Pool und Garten ist modern und gepflegt", negative: "Die Anlage ist heruntergekommen und der Pool war geschlossen" },
    ruido: { positive: "Ruhiges Zimmer, wir haben gut geschlafen", negative: "Sehr laut in der Nacht, die Wände sind hellhörig" },
    wifi: { positive: "Das WLAN war schnell und stabil", negative: "Das WLAN war langsam und instabil" },
    recepcion_checkin: { positive: "Der Check-in war schnell und unkompliziert", negative: "Lange Wartezeit an der Rezeption beim Check-in; chaotisch" },
    mantenimiento: { positive: "Alles funktionierte einwandfrei", negative: "Der Wasserhahn tropfte und die Klimaanlage war kaputt" }
  },
  titles: {
    positive: ["Sehr gut", "Gerne wieder", "Rundum zufrieden"],
    neutral: ["In Ordnung, mit Abstrichen", "Ganz okay"],
    negative: ["Enttäuschend", "Nie wieder", "Leider nicht empfehlenswert"]
  },
  closers: {
    positive: ["Gerne wieder", "Sehr empfehlenswert"],
    neutral: ["Insgesamt in Ordnung"],
    negative: ["Nicht empfehlenswert", "Nie wieder"]
  },
  contrast: "Aber"
};

const TEMPLATES: Readonly<Record<DemoLanguage, LanguageTemplates>> = Object.freeze({ es: ES_TEMPLATES, en: EN_TEMPLATES, de: DE_TEMPLATES });

/** Países ficticios plausibles por idioma (ISO 3166-1 alfa-2). */
const COUNTRIES: Readonly<Record<DemoLanguage, readonly string[]>> = Object.freeze({
  es: ["ES", "ES", "ES", "AR", "MX"],
  en: ["GB", "IE", "US"],
  de: ["DE", "DE", "AT", "CH"]
});

/** Notas por tramo y portal, coherentes con sentimentBucket (≥ 8,5 · [6, 8,5) · < 6). */
const RATINGS: Readonly<Record<DemoProvider, { scaleMax: number } & Readonly<Record<Sentiment, readonly number[]>>>> = Object.freeze({
  google: { scaleMax: 5, positive: [5], neutral: [4, 4, 3], negative: [2, 1] },
  booking: { scaleMax: 10, positive: [8.5, 8.8, 9, 9.2, 9.5, 9.8, 10], neutral: [6, 6.5, 7, 7.3, 7.5, 8, 8.3], negative: [2.5, 3, 3.5, 4, 4.5, 5, 5.5, 5.8] },
  csv: { scaleMax: 5, positive: [4.5, 5], neutral: [3, 3.5, 4], negative: [1, 1.5, 2, 2.5] }
});

/** Comentarios ficticios de encuesta (español) por tramo NPS. */
const SURVEY_COMMENTS: Readonly<Record<Sentiment, readonly string[]>> = Object.freeze({
  positive: ["Todo estupendo, repetiremos.", "Personal muy amable y habitación impecable.", "Desayuno excelente y ubicación perfecta."],
  neutral: ["Bien en general, el wifi podría mejorar.", "Correcto; el desayuno algo justo.", "Estancia agradable con pequeños detalles mejorables."],
  negative: ["Ruido por la noche y limpieza mejorable.", "Esperamos demasiado en recepción.", "La relación calidad precio no nos convenció."]
});
const STAY_TYPES = Object.freeze(["ocio", "trabajo", "familia", "pareja"] as const);

// ---------------------------------------------------------------------------
// Tipos del dataset
// ---------------------------------------------------------------------------

export type DemoReviewSeed = {
  n: number;
  /** `demo:<seed>:<n>`; clave de idempotencia del upsert. */
  externalReference: string;
  provider: DemoProvider;
  /** `<provider>_demo` (GuestReview.source). */
  source: `${DemoProvider}_demo`;
  sourceMode: ReviewSourceMode;
  bucket: Sentiment;
  score10: number;
  language: DemoLanguage;
  /** Categorías que menciona el texto (para el test; el análisis real lo hace el tick). */
  categories: ReviewCategory[];
  responded: boolean;
  isDemo: true;
  /** Lo que consume upsertReviewFromNormalized (review-meta.store.ts). */
  item: NormalizedReview;
};

export type DemoSurveyResponseSeed = {
  /** `demo:<seed>:s<k>`; clave de idempotencia (responsesJson.demoRef). */
  demoRef: string;
  score: number;
  createdAt: string;
  answers: { isDemo: true; demoRef: string; nps: number; cleanliness: number; stayType: string; comment: string };
};

export type DemoSurveySeed = {
  name: string;
  surveyType: "post_stay";
  questions: Array<Record<string, unknown>>;
  responses: DemoSurveyResponseSeed[];
  isDemo: true;
};

export type DemoDatasetStats = {
  reviews: number;
  positive: number;
  neutral: number;
  negative: number;
  responded: number;
  byProvider: Record<DemoProvider, number>;
  byLanguage: Record<DemoLanguage, number>;
  surveys: number;
  surveyResponses: number;
  shares: { positive: number; neutral: number; negative: number; responded: number };
};

export type ReputationDemoDataset = {
  propertyId: string;
  hotelName: string;
  seed: number;
  days: number;
  now: string;
  sources: DemoSourceSpec[];
  reviews: DemoReviewSeed[];
  surveys: DemoSurveySeed[];
  stats: DemoDatasetStats;
};

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/** Prefijo de externalReference para una semilla (`demo:42:`). */
export function demoReferencePrefix(seed: number): string {
  return `${DEMO_REFERENCE_PREFIX}${seed}:`;
}

/**
 * Iniciales de los autores «Huésped X.»: A-Z sin E ni Y, que minimizeAuthorName
 * (review-normalize.ts) trata como partículas («y», «e») y dejaría «Huésped» a
 * secas al guardar.
 */
export const DEMO_AUTHOR_INITIALS = "ABCDFGHIJKLMNOPQRSTUVWXZ";

/** «Huésped A.»…«Huésped Z.» (pares) o «Viajero N» (impares). */
export function demoAuthorFor(n: number): string {
  if (n % 2 === 0) return `Huésped ${DEMO_AUTHOR_INITIALS.charAt((n / 2) % DEMO_AUTHOR_INITIALS.length)}.`;
  return `Viajero ${n}`;
}

function buildBody(prng: Prng, templates: LanguageTemplates, bucket: Sentiment, categories: ReviewCategory[]): string {
  const sentences: string[] = [];
  if (bucket === "positive") {
    for (const category of categories) sentences.push(templates.fragments[category].positive);
  } else if (bucket === "negative") {
    for (const category of categories) sentences.push(templates.fragments[category].negative);
  } else {
    const [first, ...rest] = categories;
    if (first) sentences.push(templates.fragments[first].positive);
    const negatives = rest.map((category) => templates.fragments[category].negative);
    if (negatives.length > 0) {
      const [head, ...tail] = negatives;
      sentences.push(`${templates.contrast} ${lowerFirst(head as string)}`);
      sentences.push(...tail);
    }
  }
  if (prng() < 0.5) sentences.push(pick(prng, templates.closers[bucket]));
  return `${sentences.join(". ")}.`;
}

function buildReview(input: { prng: Prng; n: number; seed: number; bucket: Sentiment; responded: boolean; now: Date; days: number; hotelName: string }): DemoReviewSeed {
  const { prng, n, seed, bucket, responded, now, days, hotelName } = input;
  const provider = pickWeighted(prng, DEMO_PROVIDER_WEIGHTS);
  const language = pickWeighted(prng, DEMO_LANGUAGE_WEIGHTS);
  const templates = TEMPLATES[language];
  const spec = DEMO_SOURCE_SPECS.find((entry) => entry.provider === provider) as DemoSourceSpec;

  const ratingTable = RATINGS[provider];
  const ratingRaw = pick(prng, ratingTable[bucket]);
  const score10 = Math.round((ratingRaw / ratingTable.scaleMax) * 100) / 10;

  const window = provider === "google" ? Math.min(days, DEMO_GOOGLE_MAX_AGE_DAYS) : days;
  const ageDays = window <= 1 ? 1 : 1 + prng() * (window - 1);
  const receivedAt = new Date(now.getTime() - ageDays * MS_PER_DAY);

  const categoryCount = bucket === "neutral" ? 2 + Math.floor(prng() * 2) : 2 + Math.floor(prng() * 2);
  const categories = pickDistinct(prng, REVIEW_CATEGORIES, categoryCount);
  const title = pick(prng, templates.titles[bucket]);
  const body = buildBody(prng, templates, bucket, categories);

  const item: NormalizedReview = {
    receivedAt: receivedAt.toISOString(),
    ratingRaw,
    ratingScaleMax: ratingTable.scaleMax,
    title,
    body,
    bodyComplete: true,
    language,
    authorDisplayName: demoAuthorFor(n),
    authorCountry: pick(prng, COUNTRIES[language]),
    replyCapability: false
  };

  if (responded) {
    const draft = buildRulesDraft({
      score10,
      sentiment: bucket,
      language,
      categories: analyzeReviewDeterministic(body, language),
      title,
      body,
      hotelName,
      tone: "formal"
    });
    const repliedAt = new Date(Math.min(receivedAt.getTime() + (6 + prng() * 34) * MS_PER_HOUR, now.getTime() - MS_PER_HOUR));
    item.portalReply = { body: draft.body, repliedAt: repliedAt.toISOString() };
  }

  return {
    n,
    externalReference: `${demoReferencePrefix(seed)}${n}`,
    provider,
    source: spec.code,
    sourceMode: spec.mode,
    bucket,
    score10,
    language,
    categories,
    responded,
    isDemo: true,
    item
  };
}

function surveyQuestions(kind: "general" | "breakfast"): Array<Record<string, unknown>> {
  const questions: Array<Record<string, unknown>> = [
    { id: "nps", type: "scale", min: 0, max: 10, label: "¿Recomendaría el hotel a un amigo o familiar?" },
    { id: "cleanliness", type: "scale", min: 1, max: 5, label: "Limpieza de la habitación" }
  ];
  if (kind === "breakfast") questions.push({ id: "breakfast", type: "scale", min: 1, max: 5, label: "Variedad y calidad del desayuno" });
  questions.push({ id: "stayType", type: "choice", options: [...STAY_TYPES], label: "Motivo de la estancia" });
  questions.push({ id: "comment", type: "text", label: "¿Qué podríamos mejorar?" });
  return questions;
}

function surveyScore(prng: Prng): number {
  const roll = prng();
  if (roll < 0.6) return 9 + Math.floor(prng() * 2); // promotores 9-10
  if (roll < 0.85) return 7 + Math.floor(prng() * 2); // pasivos 7-8
  return Math.floor(prng() * 7); // detractores 0-6
}

function buildSurveys(prng: Prng, seed: number, now: Date, days: number): DemoSurveySeed[] {
  const window = Math.min(days, 90);
  const names = [`Post-estancia ${DEMO_SURVEY_SUFFIX}`, `Post-estancia · desayuno y limpieza ${DEMO_SURVEY_SUFFIX}`];
  const perSurvey = Math.floor(DEMO_SURVEY_RESPONSES / DEMO_SURVEYS);
  let k = 0;
  return names.map((name, index) => {
    const responses: DemoSurveyResponseSeed[] = [];
    const count = index === names.length - 1 ? DEMO_SURVEY_RESPONSES - perSurvey * (names.length - 1) : perSurvey;
    for (let i = 0; i < count; i += 1) {
      k += 1;
      const score = surveyScore(prng);
      const bucket: Sentiment = score >= 9 ? "positive" : score >= 7 ? "neutral" : "negative";
      const ageDays = window <= 1 ? 1 : 1 + prng() * (window - 1);
      const demoRef = `${demoReferencePrefix(seed)}s${k}`;
      responses.push({
        demoRef,
        score,
        createdAt: new Date(now.getTime() - ageDays * MS_PER_DAY).toISOString(),
        answers: {
          isDemo: true,
          demoRef,
          nps: score,
          cleanliness: score >= 9 ? 5 : score >= 7 ? 4 : score >= 5 ? 3 : 2,
          stayType: pick(prng, STAY_TYPES),
          comment: pick(prng, SURVEY_COMMENTS[bucket])
        }
      });
    }
    return { name, surveyType: "post_stay", questions: surveyQuestions(index === 0 ? "general" : "breakfast"), responses, isDemo: true };
  });
}

/**
 * Dataset completo y determinista para una propiedad. Dos llamadas con las
 * mismas opciones (incluido `now`) devuelven estructuras idénticas.
 */
export function buildReputationDemoDataset(options: DemoDatasetOptions): ReputationDemoDataset {
  const parsed = DEMO_DATASET_OPTIONS_SCHEMA.parse(options);
  const now = parsed.now ?? new Date();
  const days = parsed.days ?? DEMO_DEFAULT_DAYS;
  const total = parsed.reviews ?? DEMO_DEFAULT_REVIEWS;
  const seed = parsed.seed ?? DEMO_DEFAULT_SEED;
  const hotelName = parsed.hotelName ?? "nuestro hotel";
  const prng = createPrng(seed);

  const positiveCount = Math.round(total * DEMO_DISTRIBUTION.positive);
  const negativeCount = Math.round(total * DEMO_DISTRIBUTION.negative);
  const neutralCount = total - positiveCount - negativeCount;
  const buckets: Sentiment[] = shuffle(prng, [
    ...Array.from({ length: positiveCount }, (): Sentiment => "positive"),
    ...Array.from({ length: neutralCount }, (): Sentiment => "neutral"),
    ...Array.from({ length: negativeCount }, (): Sentiment => "negative")
  ]);
  const respondedCount = Math.round(total * DEMO_DISTRIBUTION.responded);
  const respondedIndexes = new Set(shuffle(prng, Array.from({ length: total }, (_, index) => index)).slice(0, respondedCount));

  const reviews: DemoReviewSeed[] = [];
  for (let index = 0; index < total; index += 1) {
    reviews.push(buildReview({ prng, n: index + 1, seed, bucket: buckets[index] as Sentiment, responded: respondedIndexes.has(index), now, days, hotelName }));
  }
  const surveys = buildSurveys(prng, seed, now, days);

  const byProvider: Record<DemoProvider, number> = { google: 0, booking: 0, csv: 0 };
  const byLanguage: Record<DemoLanguage, number> = { es: 0, en: 0, de: 0 };
  let positive = 0;
  let neutral = 0;
  let negative = 0;
  let responded = 0;
  for (const review of reviews) {
    byProvider[review.provider] += 1;
    byLanguage[review.language] += 1;
    if (review.bucket === "positive") positive += 1;
    else if (review.bucket === "negative") negative += 1;
    else neutral += 1;
    if (review.responded) responded += 1;
  }
  const surveyResponses = surveys.reduce((sum, survey) => sum + survey.responses.length, 0);
  const share = (value: number): number => Math.round((value / total) * 1000) / 1000;

  return {
    propertyId: parsed.propertyId,
    hotelName,
    seed,
    days,
    now: now.toISOString(),
    sources: DEMO_SOURCE_SPECS.map((spec) => ({ ...spec })),
    reviews,
    surveys,
    stats: {
      reviews: total,
      positive,
      neutral,
      negative,
      responded,
      byProvider,
      byLanguage,
      surveys: surveys.length,
      surveyResponses,
      shares: { positive: share(positive), neutral: share(neutral), negative: share(negative), responded: share(responded) }
    }
  };
}

/** Tramo esperado de una nota (paridad con sentimentBucket; `neutral` sin nota). */
export function bucketOfScore(score10: number): Sentiment {
  return sentimentBucket(score10) ?? "neutral";
}

export const DEMO_SCORE_THRESHOLDS = Object.freeze({ positive: SCORE10_POSITIVE, negative: SCORE10_NEGATIVE });

// ---------------------------------------------------------------------------
// Guarda demo: envoltorio puro de evaluateDemoTarget con entorno explícito
// ---------------------------------------------------------------------------

export type SeedTargetDecision = "allowlist" | "confirmed" | "refused";

export type SeedTargetInput = {
  propertyIds: readonly string[];
  /** Organización de cada propiedad (misma posición); `undefined` si no se conoce. */
  orgIds: ReadonlyArray<string | null | undefined>;
  allowReal: boolean;
  confirm: readonly string[];
  /** Etiqueta para el mensaje de la guarda. */
  action?: string;
};

export type SeedTargetExplanation = {
  propertyId: string;
  orgId: string | null;
  decision: SeedTargetDecision;
  /** Motivo en español cuando se rechaza. */
  reason?: string;
};

/**
 * Objeto de entorno EXPLÍCITO para demo-guard.ts a partir de los flags: conserva
 * la semántica SEED_ALLOW_REAL=1 + SEED_CONFIRM=<ids> sin leer el entorno del
 * proceso.
 */
export function guardEnvFromFlags(flags: { allowReal: boolean; confirm: readonly string[] }): DemoGuardEnv {
  const confirm = flags.confirm.map((value) => value.trim()).filter((value) => value.length > 0);
  return {
    SEED_ALLOW_REAL: flags.allowReal ? "1" : undefined,
    SEED_CONFIRM: confirm.length > 0 ? confirm.join(",") : undefined
  };
}

/** Decisión por propiedad: allowlist demo, confirmada por id de propiedad u organización, o rechazada. */
export function explainSeedTargets(input: SeedTargetInput): SeedTargetExplanation[] {
  const action = input.action ?? "seed-reputation-demo";
  const guardEnv = guardEnvFromFlags(input);
  return input.propertyIds.map((propertyId, index) => {
    const orgId = input.orgIds[index] ?? null;
    const full = evaluateDemoTarget({ orgId, propertyId, action }, guardEnv);
    if (full.allowed && full.via === "allowlist") return { propertyId, orgId, decision: "allowlist" };
    if (!input.allowReal) return { propertyId, orgId, decision: "refused", reason: full.allowed ? "Falta --allow-real." : full.reason };
    const byProperty = evaluateDemoTarget({ propertyId, action }, guardEnv);
    if (byProperty.allowed && byProperty.via === "confirmed") return { propertyId, orgId, decision: "confirmed" };
    if (orgId) {
      const byOrg = evaluateDemoTarget({ orgId, action }, guardEnv);
      if (byOrg.allowed && byOrg.via === "confirmed") return { propertyId, orgId, decision: "confirmed" };
    }
    const reason = full.allowed ? `Falta --confirm ${propertyId}${orgId ? ` (o --confirm ${orgId})` : ""}.` : full.reason;
    return { propertyId, orgId, decision: "refused", reason };
  });
}

/** Peor decisión del conjunto: `refused` > `confirmed` > `allowlist`. */
export function decideSeedTarget(input: SeedTargetInput): SeedTargetDecision {
  const decisions = explainSeedTargets(input).map((entry) => entry.decision);
  if (decisions.length === 0 || decisions.includes("refused")) return "refused";
  if (decisions.includes("confirmed")) return "confirmed";
  return "allowlist";
}

// ---------------------------------------------------------------------------
// Planes de escritura (solo filtros isDemo)
// ---------------------------------------------------------------------------

export type PurgePlanCounts = Partial<Record<"quality_cases" | "survey_responses" | "surveys" | "guest_reviews" | "review_sources", number>>;

/** Plan de purga: cinco deleteMany, todos acotados a la propiedad y a filas marcadas isDemo. */
export function buildPurgePlan(input: { propertyId: string; counts?: PurgePlanCounts }): PlannedWrite[] {
  const { propertyId } = input;
  const counts = input.counts ?? {};
  const withCount = (table: keyof PurgePlanCounts, write: PlannedWrite): PlannedWrite => (typeof counts[table] === "number" ? { ...write, count: counts[table] } : write);
  return [
    withCount("quality_cases", {
      table: "quality_cases",
      op: "deleteMany",
      where: `property_id = '${propertyId}' AND case_type = 'review_negative' AND description LIKE '[reseña:<id>]%' con <id> ∈ guest_reviews(topics_json->>'isDemo' = 'true')`
    }),
    withCount("survey_responses", {
      table: "survey_responses",
      op: "deleteMany",
      where: `survey_id ∈ surveys(property_id = '${propertyId}' AND name LIKE '%${DEMO_SURVEY_SUFFIX}%') [isDemo por nombre]`
    }),
    withCount("surveys", { table: "surveys", op: "deleteMany", where: `property_id = '${propertyId}' AND name LIKE '%${DEMO_SURVEY_SUFFIX}%' [isDemo por nombre]` }),
    withCount("guest_reviews", { table: "guest_reviews", op: "deleteMany", where: `property_id = '${propertyId}' AND topics_json->>'isDemo' = 'true'` }),
    withCount("review_sources", { table: "review_sources", op: "deleteMany", where: `property_id = '${propertyId}' AND config_json->>'isDemo' = 'true'` })
  ];
}

/** Plan de siembra: upserts idempotentes marcados isDemo (los casos los abre el tick si el módulo está activo). */
export function buildSeedPlan(dataset: ReputationDemoDataset, moduleEnabled: boolean | null): PlannedWrite[] {
  const { propertyId } = dataset;
  const negatives = dataset.stats.negative;
  const plan: PlannedWrite[] = [
    { table: "review_sources", op: "upsert", count: dataset.sources.length, where: `property_id = '${propertyId}' AND provider IN (${dataset.sources.map((s) => `'${s.code}'`).join(", ")}) · config_json.isDemo = true` },
    { table: "guest_reviews", op: "upsert", count: dataset.reviews.length, where: `property_id = '${propertyId}' AND external_reference LIKE '${demoReferencePrefix(dataset.seed)}%' · topics_json.isDemo = true` },
    { table: "surveys", op: "create", count: dataset.surveys.length, where: `property_id = '${propertyId}' AND name LIKE '%${DEMO_SURVEY_SUFFIX}%' (si no existe) [isDemo por nombre]` },
    { table: "survey_responses", op: "createMany", count: dataset.stats.surveyResponses, where: `responses_json.demoRef LIKE '${demoReferencePrefix(dataset.seed)}s%' (solo las que falten) · responses_json.isDemo = true` }
  ];
  plan.push({
    table: "quality_cases",
    op: "create",
    count: moduleEnabled === false ? 0 : negatives,
    where: moduleEnabled === false ? "ninguno: el módulo reputation_quality está apagado (el tick no corre) · isDemo vía [reseña:<id demo>]" : `review_negative por reseña demo con nota < ${SCORE10_NEGATIVE} (los abre runReputationSync) · isDemo vía [reseña:<id demo>]`
  });
  return plan;
}
