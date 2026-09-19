// Reputación · Tanda T8 · lote T8-B — clasificador y parser determinista de
// correos de notificación de reseñas
// (apps/api/src/modules/reputation/review-email.parser.ts).
//
// Reglas del fichero:
//   · función pura: sin Prisma, sin variables de entorno, sin red;
//   · classifyInboundEmail() está pensado para llamarse ANTES de
//     looksLikeBooking() en integrations/email/email-reservation.service.ts
//     (línea ~350-355): solo `review_notification` cambia el flujo actual;
//     `reservation` e `ignored` dejan que el servicio siga como hasta hoy.
//     El enganche es una línea del integrador (openIssues/mergeLines);
//   · remitentes reconocidos: tripadvisor.com, holidaycheck.*, google.com
//     (Business Profile) y booking.com/expedia.com cuando el asunto habla
//     de reseñas (/rese[ñn]a|review|bewertung|avis|opini[oó]n/i); un correo
//     de booking.com/expedia.com sin ese asunto sigue siendo `reservation`;
//   · parseReviewNotification() extrae nota, título, extracto, fecha y autor
//     MINIMIZADO («Nombre A.»); `bodyComplete: false` siempre (el correo solo
//     trae un extracto); la referencia externa es la URL canónica de la
//     reseña si aparece, si no `email:<messageId>`;
//   · una fecha NUNCA es una nota (corrección ronda 1, BD-05): «del 3/10/2026»,
//     «al 5/10» o «2 noches de 5» no dan 3/10, 5/10 ni 2/5 — la coincidencia
//     x/y se descarta si va seguida de «/dígito» (dd/mm/aaaa) o precedida de
//     una preposición de fecha (del, al, desde, hasta, from, to, vom, am, le,
//     du, au) y se busca la siguiente; «hotel de 4 estrellas» (categoría del
//     establecimiento) tampoco es una nota; sin nota el correo entra sin score10;
//   · el nombre completo del huésped no se guarda en ningún campo (HP-03): el
//     autor detectado en asunto/extracto («Nueva reseña de Juan Pérez», «Juan
//     Pérez escribió…») se sustituye en título y extracto por su forma
//     minimizada antes de devolver la reseña;
//   · fecha de recepción (BD-11): si el correo trae una fecha etiquetada
//     («Fecha: 12/09/2026», «Date: 2026-09-12», «Publicada el 12 de septiembre
//     de 2026», cabecera «Enviado:» de un reenvío) y es válida y no futura, es
//     la fecha de la reseña; si no, `email.receivedAt` y, si falta, `now`.
//
// Tests: cd apps/api && node --import tsx --test src/modules/reputation/__tests__/review-email-parser.test.mts

import type { InboundEmailLike, NormalizedReview } from "./collectors/types.js";
import { REVIEW_PROVIDER_SCALES, type ReviewProvider } from "./reputation-types.js";
import { detectLanguage } from "./review-language.js";
import { minimizeAuthorName } from "./review-normalize.js";

export const INBOUND_EMAIL_CLASSES = Object.freeze(["review_notification", "reservation", "ignored"] as const);
export type InboundEmailClass = (typeof INBOUND_EMAIL_CLASSES)[number];

export type InboundEmailClassification = {
  kind: InboundEmailClass;
  /** Portal detectado cuando `kind === "review_notification"`. */
  provider?: ReviewProvider;
  /** Motivo en español (diagnóstico). */
  reason: string;
};

/** Asunto o extracto que habla de una reseña (es/en/de/fr/pt/it). */
export const REVIEW_SUBJECT_RE = /rese[ñn]a|review|bewertung|avis|opini[oó]n|valoraci[oó]n|avalia[çc][aã]o|recensione|comentario de un hu[eé]sped|guest feedback/i;
const RESERVATION_RE = /(reserva|booking|reservation|confirmaci[oó]n|confirmation|check[- ]?in|noche?s|estancia|alojamiento|buchung|r[eé]servation)/i;
const GOOGLE_BUSINESS_RE = /business profile|perfil de (?:empresa|negocio)|my business|google maps|maps/i;

type SenderRule = { test: (domain: string) => boolean; provider: ReviewProvider; requireSubject: boolean; needsGoogleHint?: boolean };

const SENDER_RULES: readonly SenderRule[] = Object.freeze([
  { test: (domain) => domain === "tripadvisor.com" || domain.endsWith(".tripadvisor.com"), provider: "tripadvisor", requireSubject: true },
  { test: (domain) => /(^|\.)holidaycheck\.[a-z.]+$/.test(domain), provider: "holidaycheck", requireSubject: true },
  { test: (domain) => domain === "google.com" || domain.endsWith(".google.com"), provider: "google", requireSubject: true, needsGoogleHint: true },
  { test: (domain) => domain === "booking.com" || domain.endsWith(".booking.com"), provider: "booking", requireSubject: true },
  { test: (domain) => domain === "expedia.com" || domain.endsWith(".expedia.com") || domain.endsWith(".expediapartnercentral.com"), provider: "expedia", requireSubject: true }
]);

/** Dominio del remitente («Nombre <noreply@e.tripadvisor.com>» → `e.tripadvisor.com`). */
export function senderDomain(fromAddress: string | null | undefined): string {
  if (typeof fromAddress !== "string") return "";
  const match = fromAddress.match(/@([A-Za-z0-9.-]+)/);
  return match ? (match[1] as string).toLowerCase().replace(/\.+$/, "") : "";
}

/** Clasificación detallada (portal y motivo). */
export function classifyInboundEmailDetailed(email: InboundEmailLike): InboundEmailClassification {
  const domain = senderDomain(email.fromAddress);
  const subject = email.subject ?? "";
  const snippet = email.snippet ?? "";
  const haystack = `${subject} ${snippet}`;
  for (const rule of SENDER_RULES) {
    if (!rule.test(domain)) continue;
    const talksAboutReviews = REVIEW_SUBJECT_RE.test(subject) || REVIEW_SUBJECT_RE.test(snippet);
    if (rule.needsGoogleHint && !GOOGLE_BUSINESS_RE.test(haystack)) {
      return { kind: "ignored", reason: "Correo de google.com sin referencia a Business Profile." };
    }
    if (talksAboutReviews) {
      return { kind: "review_notification", provider: rule.provider, reason: `Remitente ${domain} con asunto de reseña.` };
    }
    if (rule.provider === "booking" || rule.provider === "expedia") {
      return { kind: "reservation", reason: `Remitente OTA ${domain} sin asunto de reseña: sigue el flujo de reservas.` };
    }
    return { kind: "ignored", reason: `Remitente ${domain} sin asunto de reseña.` };
  }
  if (RESERVATION_RE.test(haystack)) {
    return { kind: "reservation", reason: "Asunto o extracto con vocabulario de reserva." };
  }
  return { kind: "ignored", reason: "Remitente no reconocido y sin vocabulario de reseña ni reserva." };
}

/** Clasificación simple: `review_notification` | `reservation` | `ignored`. */
export function classifyInboundEmail(email: InboundEmailLike): InboundEmailClass {
  return classifyInboundEmailDetailed(email).kind;
}

// ---------------------------------------------------------------------------
// Parser determinista
// ---------------------------------------------------------------------------

const RATING_WITH_SCALE_RE = /(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:\/|de|of|von|sur|em|su|sobre)\s*(5|6|10)\b/gi;
/** Preposiciones de fecha justo antes de «3/10»: «del 3/10», «al 5/10», «from 3/10»… */
const DATE_PREPOSITION_BEFORE_RE = /(?:^|[^\p{L}])(?:del|el|al|desde|hasta|entre|from|to|until|on|vom|am|bis|le|du|au|dal|al|até|em)\s*$/iu;
/** «3/10» seguido de «/2026» (dd/mm/aaaa) o de «-2026». */
const DATE_TAIL_AFTER_RE = /^\s*[\/.-]\s*\d/;
/** «hotel de 4 estrellas» es la categoría del establecimiento, no una valoración. */
const CATEGORY_BEFORE_RE = /(?:hotel|hoteles|establecimiento|alojamiento|hôtel|albergo|category|categor[ií]a|catégorie|kategorie|classe)\s+(?:de\s+|of\s+|à\s+|a\s+|mit\s+)?$/iu;
const RATING_STARS_RE = /(\d(?:[.,]\d)?)\s*(?:estrellas?|stars?|sterne|[ée]toiles?|estrelas?|stelle|burbujas?|bubbles?)/gi;
const RATING_SUNS_RE = /(\d(?:[.,]\d)?)\s*(?:soles|sonnen|suns?)/i;
const RATING_LABEL_RE = /(?:puntuaci[oó]n|nota|score|rating|bewertung|note|pontua[çc][aã]o)\s*[:：]?\s*(\d{1,2}(?:[.,]\d{1,2})?)/i;
const QUOTED_TITLE_RE = /[«“"]([^»”"]{3,160})[»”"]/;
const SUBJECT_PREFIX_RE = /^(?:(?:nueva|new|neue|nouvel(?:le)?|nova|nuova)\s+(?:rese[ñn]a|review|bewertung|avis|opini[oó]n|valoraci[oó]n|avalia[çc][aã]o|recensione)\s*(?:de|from|von|de la part de|do|di)?\s*[:\-–—]?\s*)/i;
const AUTHOR_RE = /\b(?:de|from|von|par|do|da|di|by)\s+([\p{Lu}][\p{L}\p{M}'’-]+(?:\s+[\p{Lu}][\p{L}\p{M}'’-]+){0,2})\b/u;
/** «Juan Pérez escribió una reseña», «Anna Schmidt hat … geschrieben», «John Smith wrote/left a review». */
const AUTHOR_VERB_RE = /(?:^|[.!?]\s+|\n)\s*([\p{Lu}][\p{L}\p{M}'’-]+(?:\s+[\p{Lu}][\p{L}\p{M}'’-]+){1,2})\s+(?:escribi[oó]|ha escrito|dej[oó]|public[oó]|wrote|has written|left|posted|hat|a écrit|a laissé|ha scritto|escreveu|deixou)\b/u;
/** Fechas etiquetadas: «Fecha: 12/09/2026», «Date: 2026-09-12», «Publicada el 12 de septiembre de 2026», «Sent: September 12, 2026». */
const LABELED_DATE_RE = /(?:fecha|date|datum|enviad[oa]|sent|publicad[oa]|posted|escrit[oa]|written|received|recibid[oa])\s*(?:el|on|le|am|:)?\s*[:\-–]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{1,2}\s+(?:de\s+)?[\p{L}]+\.?\s+(?:de\s+)?\d{4}|[\p{L}]+\.?\s+\d{1,2},?\s+\d{4})/iu;
const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  enero: 1, ene: 1, january: 1, jan: 1, januar: 1, janvier: 1, janeiro: 1, gennaio: 1,
  febrero: 2, feb: 2, february: 2, februar: 2, février: 2, fevrier: 2, fevereiro: 2, febbraio: 2,
  marzo: 3, mar: 3, march: 3, märz: 3, maerz: 3, mars: 3, março: 3, marco: 3,
  abril: 4, abr: 4, april: 4, apr: 4, avril: 4, aprile: 4,
  mayo: 5, may: 5, mai: 5, maio: 5, maggio: 5,
  junio: 6, jun: 6, june: 6, juni: 6, juin: 6, junho: 6, giugno: 6,
  julio: 7, jul: 7, july: 7, juli: 7, juillet: 7, julho: 7, luglio: 7,
  agosto: 8, ago: 8, august: 8, aug: 8, août: 8, aout: 8,
  septiembre: 9, sep: 9, sept: 9, september: 9, septembre: 9, setembro: 9, settembre: 9,
  octubre: 10, oct: 10, october: 10, oktober: 10, octobre: 10, outubro: 10, ottobre: 10,
  noviembre: 11, nov: 11, november: 11, novembre: 11, novembro: 11,
  diciembre: 12, dic: 12, dec: 12, december: 12, dezember: 12, décembre: 12, decembre: 12, dezembro: 12, dicembre: 12
});
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const TRACKING_PARAM_RE = /^(utm_|mc_|fbclid|gclid|ref$|source$|campaign$|medium$)/i;

function toNumber(value: string): number | null {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

/** `true` si la coincidencia «x/y» de `text` en `index` forma parte de una fecha (dd/mm/aaaa, «del 3/10»). */
function looksLikeDate(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 12), index);
  const after = text.slice(index + length, index + length + 6);
  return DATE_PREPOSITION_BEFORE_RE.test(before) || DATE_TAIL_AFTER_RE.test(after);
}

/** Nota y escala de un texto de correo; `null` cuando no se encuentra. Una fecha nunca cuenta como nota. */
export function extractRatingFromText(text: string, provider: ReviewProvider): { rating: number; scaleMax: number } | null {
  RATING_WITH_SCALE_RE.lastIndex = 0;
  for (let match = RATING_WITH_SCALE_RE.exec(text); match; match = RATING_WITH_SCALE_RE.exec(text)) {
    if (looksLikeDate(text, match.index, match[0].length)) continue;
    const rating = toNumber(match[1] as string);
    const scale = Number(match[2]);
    if (rating !== null && rating <= scale) {
      RATING_WITH_SCALE_RE.lastIndex = 0;
      return { rating, scaleMax: scale };
    }
  }
  RATING_WITH_SCALE_RE.lastIndex = 0;
  const suns = text.match(RATING_SUNS_RE);
  if (suns) {
    const rating = toNumber(suns[1] as string);
    if (rating !== null && rating <= 6) return { rating, scaleMax: 6 };
  }
  RATING_STARS_RE.lastIndex = 0;
  for (let stars = RATING_STARS_RE.exec(text); stars; stars = RATING_STARS_RE.exec(text)) {
    // «hotel de 4 estrellas» (categoría) se salta y se busca la siguiente coincidencia.
    if (CATEGORY_BEFORE_RE.test(text.slice(Math.max(0, stars.index - 24), stars.index))) continue;
    const rating = toNumber(stars[1] as string);
    if (rating !== null && rating <= 5) {
      RATING_STARS_RE.lastIndex = 0;
      return { rating, scaleMax: 5 };
    }
  }
  RATING_STARS_RE.lastIndex = 0;
  const labeled = text.match(RATING_LABEL_RE);
  if (labeled) {
    const rating = toNumber(labeled[1] as string);
    const scale = REVIEW_PROVIDER_SCALES[provider] ?? (rating !== null && rating > 6 ? 10 : 5);
    if (rating !== null && rating <= scale) return { rating, scaleMax: scale };
  }
  return null;
}

/** URL canónica de la reseña en el portal (sin parámetros de seguimiento). */
export function extractPortalUrl(text: string, provider: ReviewProvider): string | undefined {
  const urls = text.match(URL_RE) ?? [];
  const hint = provider === "google" ? "google." : `${provider}.`;
  for (const raw of urls) {
    const cleaned = raw.replace(/[.,;:)]+$/, "");
    let url: URL;
    try {
      url = new URL(cleaned);
    } catch {
      continue;
    }
    if (!url.hostname.toLowerCase().includes(hint)) continue;
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAM_RE.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  }
  return undefined;
}

function extractTitle(subject: string, snippet: string): string | undefined {
  const quoted = subject.match(QUOTED_TITLE_RE) ?? snippet.match(QUOTED_TITLE_RE);
  if (quoted) return (quoted[1] as string).trim();
  const stripped = subject.replace(SUBJECT_PREFIX_RE, "").trim();
  if (stripped && stripped.length >= 3 && stripped.toLowerCase() !== subject.trim().toLowerCase()) return stripped.slice(0, 160);
  return undefined;
}

/** Nombre del autor tal como aparece en el correo (aún sin minimizar) o undefined. */
function extractAuthorRaw(subject: string, snippet: string): string | undefined {
  const match = subject.match(AUTHOR_RE) ?? snippet.match(AUTHOR_RE) ?? subject.match(AUTHOR_VERB_RE) ?? snippet.match(AUTHOR_VERB_RE);
  const raw = match?.[1]?.trim();
  return raw && raw.length >= 2 ? raw : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sustituye el nombre completo del autor (y sus apellidos sueltos de ≥ 3 letras) por la forma minimizada. */
export function scrubAuthorName(text: string | undefined, rawName: string | undefined, minimized: string | undefined): string | undefined {
  if (!text || !rawName || !minimized || rawName === minimized) return text;
  let out = text.replace(new RegExp(`(?<![\\p{L}\\p{M}])${escapeRegExp(rawName)}(?![\\p{L}\\p{M}])`, "giu"), minimized);
  const words = rawName.split(/\s+/);
  for (const surname of words.slice(1)) {
    if (surname.length < 3 || /^(?:de|del|la|las|los|da|das|do|dos|van|von|der|den|di|du|le|y|e)$/i.test(surname)) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{M}])${escapeRegExp(surname)}(?![\\p{L}\\p{M}])`, "gu"), `${surname.charAt(0)}.`);
  }
  return out;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function utcDate(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const fullYear = year < 100 ? 2000 + year : year;
  if (fullYear < 2000 || fullYear > 2100 || month < 1 || month > 12 || day < 1 || day > daysInMonth(fullYear, month)) return null;
  return new Date(Date.UTC(fullYear, month - 1, day, 12)).toISOString();
}

/**
 * Fecha etiquetada del correo («Fecha: 12/09/2026», «Date: 2026-09-12», «12 de
 * septiembre de 2026», «September 12, 2026»; d/m salvo que el segundo número
 * supere 12) como ISO a las 12:00 UTC; `undefined` si no hay o es inválida.
 */
export function extractLabeledDate(text: string): string | undefined {
  const match = text.match(LABELED_DATE_RE);
  if (!match) return undefined;
  const raw = (match[1] as string).trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3])) ?? undefined;
  const numeric = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = Number(numeric[3]);
    const [day, month] = a > 12 && b <= 12 ? [a, b] : b > 12 && a <= 12 ? [b, a] : [a, b];
    return utcDate(year, month, day) ?? undefined;
  }
  const dayFirst = raw.match(/^(\d{1,2})\s+(?:de\s+)?([\p{L}]+)\.?\s+(?:de\s+)?(\d{4})$/u);
  if (dayFirst) {
    const month = MONTHS[(dayFirst[2] as string).toLowerCase()];
    return month ? (utcDate(Number(dayFirst[3]), month, Number(dayFirst[1])) ?? undefined) : undefined;
  }
  const monthFirst = raw.match(/^([\p{L}]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/u);
  if (monthFirst) {
    const month = MONTHS[(monthFirst[1] as string).toLowerCase()];
    return month ? (utcDate(Number(monthFirst[3]), month, Number(monthFirst[2])) ?? undefined) : undefined;
  }
  return undefined;
}

function toIso(value: string | Date | null | undefined, fallback: Date): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return fallback.toISOString();
}

export type ParseReviewNotificationOptions = {
  /** Fecha de respaldo cuando el correo no trae `receivedAt`. */
  now?: Date;
};

/**
 * Convierte un correo de notificación en una reseña normalizada (extracto,
 * `bodyComplete: false`, autor minimizado). Devuelve `null` si el correo no
 * es una notificación de reseña de ese portal o no aporta nota ni texto.
 */
export function parseReviewNotification(email: InboundEmailLike, provider: ReviewProvider, options: ParseReviewNotificationOptions = {}): NormalizedReview | null {
  const classification = classifyInboundEmailDetailed(email);
  if (classification.kind !== "review_notification" || classification.provider !== provider) return null;
  const subject = (email.subject ?? "").trim();
  const snippet = (email.snippet ?? email.bodyText ?? "").replace(/\s+/g, " ").trim();
  const haystack = `${subject}\n${snippet}\n${email.bodyText ?? ""}`;
  const rating = extractRatingFromText(haystack, provider);
  const rawAuthor = extractAuthorRaw(subject, snippet);
  const author = rawAuthor ? minimizeAuthorName(rawAuthor) : undefined;
  // El nombre completo del huésped no se guarda: título y extracto llevan la forma minimizada.
  const title = scrubAuthorName(extractTitle(subject, snippet), rawAuthor, author);
  const body = scrubAuthorName(snippet.length > 0 ? snippet.slice(0, 2000) : undefined, rawAuthor, author);
  if (!rating && !body) return null;
  const portalUrl = extractPortalUrl(haystack, provider);
  const messageId = email.messageId?.trim();
  const externalId = portalUrl ?? (messageId ? `email:${messageId}` : undefined);
  const language = detectLanguage(body ?? title ?? "").code;
  const now = options.now ?? new Date();
  const labeled = extractLabeledDate(haystack);
  const receivedAt = labeled && Date.parse(labeled) <= now.getTime() ? labeled : toIso(email.receivedAt, now);
  return {
    ...(externalId ? { externalId } : {}),
    receivedAt,
    ratingRaw: rating?.rating ?? null,
    ratingScaleMax: rating?.scaleMax ?? null,
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
    bodyComplete: false,
    language,
    ...(author ? { authorDisplayName: author } : {}),
    ...(portalUrl ? { portalUrl } : {}),
    replyCapability: false,
    portalProvider: provider
  };
}
