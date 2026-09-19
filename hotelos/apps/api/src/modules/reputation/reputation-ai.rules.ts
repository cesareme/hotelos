// Reputación · Tanda T8 · lote T8-B — respaldo por reglas del puerto de IA
// (apps/api/src/modules/reputation/reputation-ai.rules.ts).
//
// Reglas del fichero:
//   · función pura: sin Prisma, sin variables de entorno, sin red, sin
//     proveedor de IA; `describe()` es honesto (`configured: false`,
//     `provider: "none"`) y todo lo que sale va etiquetado
//     `dictionary` (análisis) o `rules` (borrador);
//   · analyzeReview = detectLanguage + diccionario (el texto pasa por
//     maskReviewForLlm igualmente, para que los snippets no lleven PII);
//     sentimiento = sentimentBucket(score10) si hay nota; si no, polaridad
//     del diccionario; si tampoco, `neutral`;
//   · draftResponse = plantillas por tramo (≥ 8,5 agradecimiento; 6-8,49
//     agradecimiento + mejora; < 6 disculpa + canal privado + invitación) e
//     idioma es/en/de/fr/pt (`und` y otros → es), ≤ 120 palabras, sin datos
//     de la estancia (habitación, fechas, importes), firma «Dirección de
//     <hotelName>» en todos los idiomas salvo `signature` explícita.
//
// Tests: cd apps/api && node --import tsx --test src/modules/reputation/__tests__/reputation-ai-rules.test.mts

import { maskReviewForLlm } from "./mask-pii.js";
import type {
  AnalyzeReviewInput,
  AnalyzeReviewOutput,
  DraftResponseInput,
  DraftResponseOutput,
  ReputationAiDescription,
  ReputationAiPort,
  ResponseTone
} from "./reputation-ai.port.js";
import { REVIEW_CATEGORY_LABELS_ES, sentimentBucket, type CategoryMention, type ReviewCategory, type Sentiment } from "./reputation-types.js";
import { analyzeReviewDeterministic, mapPortalSubscores, mergeMentions, polarityFromMentions } from "./review-categories.dictionary.js";
import { detectLanguage, normalizeLanguageCode, type DetectableLanguage } from "./review-language.js";

export const DRAFT_MAX_WORDS = 120;
export const SUMMARY_MAX_LENGTH = 200;

export const DRAFT_LANGUAGES = Object.freeze(["es", "en", "de", "fr", "pt"] as const);
export type DraftLanguage = (typeof DRAFT_LANGUAGES)[number];

type Bucket = Sentiment;

const CATEGORY_LABELS: Readonly<Record<DraftLanguage, Readonly<Record<ReviewCategory, string>>>> = Object.freeze({
  es: REVIEW_CATEGORY_LABELS_ES,
  en: Object.freeze({
    limpieza: "cleanliness",
    habitacion: "the room",
    personal: "our team",
    desayuno: "breakfast",
    restauracion: "our restaurant",
    ubicacion: "the location",
    precio_valor: "value for money",
    instalaciones: "the facilities",
    ruido: "noise",
    wifi: "the Wi-Fi",
    recepcion_checkin: "check-in",
    mantenimiento: "maintenance"
  }),
  de: Object.freeze({
    limpieza: "die Sauberkeit",
    habitacion: "das Zimmer",
    personal: "unser Team",
    desayuno: "das Frühstück",
    restauracion: "unser Restaurant",
    ubicacion: "die Lage",
    precio_valor: "das Preis-Leistungs-Verhältnis",
    instalaciones: "die Einrichtungen",
    ruido: "den Lärm",
    wifi: "das WLAN",
    recepcion_checkin: "den Check-in",
    mantenimiento: "die Instandhaltung"
  }),
  fr: Object.freeze({
    limpieza: "la propreté",
    habitacion: "la chambre",
    personal: "notre équipe",
    desayuno: "le petit-déjeuner",
    restauracion: "notre restaurant",
    ubicacion: "l’emplacement",
    precio_valor: "le rapport qualité-prix",
    instalaciones: "les installations",
    ruido: "le bruit",
    wifi: "le Wi-Fi",
    recepcion_checkin: "l’arrivée",
    mantenimiento: "la maintenance"
  }),
  pt: Object.freeze({
    limpieza: "a limpeza",
    habitacion: "o quarto",
    personal: "a nossa equipa",
    desayuno: "o pequeno-almoço",
    restauracion: "o nosso restaurante",
    ubicacion: "a localização",
    precio_valor: "a relação qualidade-preço",
    instalaciones: "as instalações",
    ruido: "o ruído",
    wifi: "o Wi-Fi",
    recepcion_checkin: "o check-in",
    mantenimiento: "a manutenção"
  })
});

type Template = {
  greeting: Record<ResponseTone, string>;
  positive: string;
  positiveWith: (labels: string) => string;
  neutral: string;
  neutralWith: (labels: string) => string;
  negative: string;
  negativeWith: (labels: string) => string;
  closing: Record<Bucket, string>;
  and: string;
};

const TEMPLATES: Readonly<Record<DraftLanguage, Template>> = Object.freeze({
  es: {
    greeting: { formal: "Estimado huésped:", cercano: "Hola:" },
    positive: "Muchas gracias por dedicar unos minutos a compartir su experiencia. Nos alegra saber que su estancia fue de su agrado y transmitiremos sus palabras a todo el equipo.",
    positiveWith: (labels) => `Muchas gracias por dedicar unos minutos a compartir su experiencia. Nos alegra especialmente que destaque ${labels}; transmitiremos sus palabras a todo el equipo.`,
    neutral: "Gracias por su valoración y por sus comentarios. Nos ayudan a seguir mejorando y tomamos nota de los puntos que menciona para trabajar en ellos.",
    neutralWith: (labels) => `Gracias por su valoración y por sus comentarios. Tomamos nota de lo que indica sobre ${labels} y ya estamos trabajando para mejorarlo.`,
    negative: "Lamentamos sinceramente que su estancia no haya estado a la altura de lo que esperaba. Sus comentarios son importantes para nosotros y los hemos trasladado al equipo responsable.",
    negativeWith: (labels) => `Lamentamos sinceramente que su estancia no haya estado a la altura de lo que esperaba, en especial en lo relativo a ${labels}. Hemos trasladado sus comentarios al equipo responsable.`,
    closing: {
      positive: "Esperamos tener la oportunidad de darle la bienvenida de nuevo muy pronto.",
      neutral: "Esperamos poder ofrecerle una experiencia aún mejor en su próxima visita.",
      negative: "Nos gustaría conocer más detalles para resolverlo: puede escribirnos directamente al hotel y le atenderemos personalmente. Esperamos poder ofrecerle una estancia a la altura en una próxima ocasión."
    },
    and: " y "
  },
  en: {
    greeting: { formal: "Dear guest,", cercano: "Hello," },
    positive: "Thank you very much for taking the time to share your experience. We are delighted that you enjoyed your stay, and we will pass your kind words on to the whole team.",
    positiveWith: (labels) => `Thank you very much for taking the time to share your experience. We are especially glad that you highlighted ${labels}; we will pass your kind words on to the whole team.`,
    neutral: "Thank you for your rating and your comments. They help us keep improving, and we have noted the points you mention so we can work on them.",
    neutralWith: (labels) => `Thank you for your rating and your comments. We have noted what you say about ${labels} and we are already working to improve it.`,
    negative: "We sincerely regret that your stay did not live up to your expectations. Your comments matter to us and we have shared them with the team responsible.",
    negativeWith: (labels) => `We sincerely regret that your stay did not live up to your expectations, particularly regarding ${labels}. We have shared your comments with the team responsible.`,
    closing: {
      positive: "We hope to have the pleasure of welcoming you back very soon.",
      neutral: "We hope to offer you an even better experience on your next visit.",
      negative: "We would like to learn more so we can put things right: please contact the hotel directly and we will attend to you personally. We hope to offer you the stay you deserve on a future occasion."
    },
    and: " and "
  },
  de: {
    greeting: { formal: "Sehr geehrter Gast,", cercano: "Hallo," },
    positive: "vielen Dank, dass Sie sich die Zeit genommen haben, Ihre Erfahrung zu teilen. Es freut uns sehr, dass Ihnen Ihr Aufenthalt gefallen hat; wir geben Ihr Lob an das gesamte Team weiter.",
    positiveWith: (labels) => `vielen Dank, dass Sie sich die Zeit genommen haben, Ihre Erfahrung zu teilen. Besonders freut uns Ihr Lob für ${labels}; wir geben es an das gesamte Team weiter.`,
    neutral: "vielen Dank für Ihre Bewertung und Ihre Anmerkungen. Sie helfen uns, besser zu werden; die genannten Punkte haben wir notiert und arbeiten daran.",
    neutralWith: (labels) => `vielen Dank für Ihre Bewertung und Ihre Anmerkungen. Ihre Hinweise zu ${labels} haben wir notiert und arbeiten bereits an Verbesserungen.`,
    negative: "es tut uns aufrichtig leid, dass Ihr Aufenthalt nicht Ihren Erwartungen entsprochen hat. Ihre Rückmeldung ist uns wichtig, und wir haben sie an das verantwortliche Team weitergegeben.",
    negativeWith: (labels) => `es tut uns aufrichtig leid, dass Ihr Aufenthalt nicht Ihren Erwartungen entsprochen hat, insbesondere in Bezug auf ${labels}. Wir haben Ihre Rückmeldung an das verantwortliche Team weitergegeben.`,
    closing: {
      positive: "Wir hoffen, Sie bald wieder bei uns begrüßen zu dürfen.",
      neutral: "Wir hoffen, Ihnen bei Ihrem nächsten Besuch ein noch besseres Erlebnis bieten zu können.",
      negative: "Gern möchten wir mehr erfahren, um es in Ordnung zu bringen: Bitte wenden Sie sich direkt an das Hotel, wir kümmern uns persönlich darum. Wir hoffen, Ihnen bei einem nächsten Aufenthalt gerecht zu werden."
    },
    and: " und "
  },
  fr: {
    greeting: { formal: "Cher client, chère cliente,", cercano: "Bonjour," },
    positive: "Merci beaucoup d’avoir pris le temps de partager votre expérience. Nous sommes ravis que votre séjour vous ait plu et nous transmettrons vos mots à toute l’équipe.",
    positiveWith: (labels) => `Merci beaucoup d’avoir pris le temps de partager votre expérience. Nous sommes particulièrement heureux que vous souligniez ${labels} ; nous transmettrons vos mots à toute l’équipe.`,
    neutral: "Merci pour votre note et vos commentaires. Ils nous aident à progresser et nous avons pris note des points que vous mentionnez pour y travailler.",
    neutralWith: (labels) => `Merci pour votre note et vos commentaires. Nous avons pris note de vos remarques concernant ${labels} et nous y travaillons déjà.`,
    negative: "Nous regrettons sincèrement que votre séjour n’ait pas été à la hauteur de vos attentes. Vos commentaires comptent pour nous et nous les avons transmis à l’équipe concernée.",
    negativeWith: (labels) => `Nous regrettons sincèrement que votre séjour n’ait pas été à la hauteur de vos attentes, notamment concernant ${labels}. Nous avons transmis vos commentaires à l’équipe concernée.`,
    closing: {
      positive: "Nous espérons avoir le plaisir de vous accueillir à nouveau très bientôt.",
      neutral: "Nous espérons vous offrir une expérience encore meilleure lors de votre prochaine visite.",
      negative: "Nous aimerions en savoir plus afin d’y remédier : n’hésitez pas à contacter directement l’hôtel, nous vous répondrons personnellement. Nous espérons pouvoir vous offrir un séjour à la hauteur lors d’une prochaine occasion."
    },
    and: " et "
  },
  pt: {
    greeting: { formal: "Estimado hóspede,", cercano: "Olá," },
    positive: "Muito obrigado por dedicar uns minutos a partilhar a sua experiência. Ficamos muito contentes por ter gostado da sua estadia e vamos transmitir as suas palavras a toda a equipa.",
    positiveWith: (labels) => `Muito obrigado por dedicar uns minutos a partilhar a sua experiência. Ficamos especialmente contentes por destacar ${labels}; vamos transmitir as suas palavras a toda a equipa.`,
    neutral: "Obrigado pela sua avaliação e pelos seus comentários. Ajudam-nos a continuar a melhorar e tomámos nota dos pontos que menciona para trabalhar neles.",
    neutralWith: (labels) => `Obrigado pela sua avaliação e pelos seus comentários. Tomámos nota do que indica sobre ${labels} e já estamos a trabalhar para melhorar.`,
    negative: "Lamentamos sinceramente que a sua estadia não tenha correspondido ao que esperava. Os seus comentários são importantes para nós e já os transmitimos à equipa responsável.",
    negativeWith: (labels) => `Lamentamos sinceramente que a sua estadia não tenha correspondido ao que esperava, sobretudo no que diz respeito a ${labels}. Já transmitimos os seus comentários à equipa responsável.`,
    closing: {
      positive: "Esperamos ter a oportunidade de o receber novamente muito em breve.",
      neutral: "Esperamos poder oferecer-lhe uma experiência ainda melhor na sua próxima visita.",
      negative: "Gostaríamos de conhecer mais detalhes para o resolver: pode contactar diretamente o hotel e atendê-lo-emos pessoalmente. Esperamos poder oferecer-lhe uma estadia à altura numa próxima ocasião."
    },
    and: " e "
  }
});

/** Cuenta palabras separadas por espacios. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/** Idioma del borrador: es/en/de/fr/pt; `und`, `it` y otros → es. */
export function draftLanguageFor(language: string | null | undefined): DraftLanguage {
  const code = normalizeLanguageCode(language);
  return (DRAFT_LANGUAGES as readonly string[]).includes(code) ? (code as DraftLanguage) : "es";
}

/** Tramo del borrador: nota si la hay; si no, el sentimiento recibido. */
export function bucketFor(score10: number | null | undefined, sentiment: Sentiment): Bucket {
  return sentimentBucket(score10) ?? sentiment;
}

function joinLabels(labels: string[], connector: string): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")}${connector}${labels[labels.length - 1]}`;
}

function pickCategoryLabels(categories: ReadonlyArray<CategoryMention>, sentiment: -1 | 1, language: DraftLanguage, max = 2): string[] {
  const labels = CATEGORY_LABELS[language];
  return categories
    .filter((mention) => mention.sentiment === sentiment && mention.confidence >= 0.5)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, max)
    .map((mention) => (language === "es" ? labels[mention.category].toLowerCase() : labels[mention.category]));
}

/** Borrador determinista por tramo e idioma (≤ 120 palabras). */
export function buildRulesDraft(input: DraftResponseInput): DraftResponseOutput {
  const language = draftLanguageFor(input.language);
  const template = TEMPLATES[language];
  const tone: ResponseTone = input.tone ?? "formal";
  const bucket = bucketFor(input.score10, input.sentiment);
  const hotelName = input.hotelName.trim() || "nuestro hotel";
  const signature = input.signature?.trim() || `Dirección de ${hotelName}`;

  let body: string;
  if (bucket === "positive") {
    const labels = pickCategoryLabels(input.categories, 1, language);
    body = labels.length > 0 ? template.positiveWith(joinLabels(labels, template.and)) : template.positive;
  } else if (bucket === "neutral") {
    const labels = pickCategoryLabels(input.categories, -1, language);
    body = labels.length > 0 ? template.neutralWith(joinLabels(labels, template.and)) : template.neutral;
  } else {
    const labels = pickCategoryLabels(input.categories, -1, language);
    body = labels.length > 0 ? template.negativeWith(joinLabels(labels, template.and)) : template.negative;
  }

  const paragraphs = [template.greeting[tone], body, template.closing[bucket], signature];
  let text = paragraphs.join("\n\n");
  if (countWords(text) > DRAFT_MAX_WORDS) {
    // Las plantillas están calibradas por debajo del límite; si un nombre de
    // hotel muy largo lo supera, se recorta la despedida antes que la firma.
    text = [template.greeting[tone], body, signature].join("\n\n");
  }
  return { body: text, source: "rules", language };
}

function summarize(categories: ReadonlyArray<CategoryMention>, sentiment: Sentiment): string {
  const positives = categories.filter((mention) => mention.sentiment > 0).map((mention) => REVIEW_CATEGORY_LABELS_ES[mention.category].toLowerCase());
  const negatives = categories.filter((mention) => mention.sentiment < 0).map((mention) => REVIEW_CATEGORY_LABELS_ES[mention.category].toLowerCase());
  const parts: string[] = [];
  if (positives.length > 0) parts.push(`Positivo: ${positives.join(", ")}`);
  if (negatives.length > 0) parts.push(`Negativo: ${negatives.join(", ")}`);
  if (parts.length === 0) {
    const label = sentiment === "positive" ? "positiva" : sentiment === "negative" ? "negativa" : "neutra";
    parts.push(`Reseña ${label} sin categorías detectadas por diccionario`);
  }
  const summary = parts.join(" · ");
  return summary.length > SUMMARY_MAX_LENGTH ? `${summary.slice(0, SUMMARY_MAX_LENGTH - 1)}…` : summary;
}

function sentimentFromPolarity(polarity: -1 | 0 | 1 | null): Sentiment | null {
  if (polarity === null) return null;
  return polarity > 0 ? "positive" : polarity < 0 ? "negative" : "neutral";
}

/** Respaldo por reglas: diccionario + plantillas; nunca llama a un proveedor. */
export class RulesReputationAi implements ReputationAiPort {
  describe(): ReputationAiDescription {
    return { configured: false, provider: "none" };
  }

  async analyzeReview(input: AnalyzeReviewInput): Promise<AnalyzeReviewOutput> {
    const fullText = [input.title?.trim(), input.text?.trim()].filter((part): part is string => Boolean(part)).join(". ");
    const masked = maskReviewForLlm(fullText).masked;
    const declared = normalizeLanguageCode(input.language);
    const language: DetectableLanguage | "und" = declared !== "und" ? declared : detectLanguage(masked).code;
    const fromText = analyzeReviewDeterministic(masked, language);
    const fromPortal = mapPortalSubscores(input.subscores);
    const categories = mergeMentions(fromPortal, fromText);
    const sentiment: Sentiment = sentimentBucket(input.score10) ?? sentimentFromPolarity(polarityFromMentions(categories)) ?? "neutral";
    return {
      language,
      sentiment,
      summary: summarize(categories, sentiment),
      categories,
      source: "dictionary",
      note: "llm_not_configured"
    };
  }

  async draftResponse(input: DraftResponseInput): Promise<DraftResponseOutput> {
    return buildRulesDraft(input);
  }
}
