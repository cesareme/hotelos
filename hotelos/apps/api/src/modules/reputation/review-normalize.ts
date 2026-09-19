// Reputación · Tanda T8 · lote T8-B — normalización de notas, hash de contenido
// y referencia externa (apps/api/src/modules/reputation/review-normalize.ts).
//
// Reglas del fichero:
//   · función pura: sin Prisma, sin variables de entorno, sin red;
//   · `score10` es la nota comparable entre portales (0-10, 1 decimal) y
//     `score5` la que cabe hoy en GuestReview.rating (Decimal(3,2): 10,00 no
//     cabe, 5,00 sí) hasta que el parche T8-L0 añada la columna score10;
//   · `contentHash` decide `created | updated | unchanged` en el upsert y
//     `externalReferenceFor` da la clave natural (id del portal o `h:<hash>`).
//
// Tests: cd apps/api && node --import tsx --test src/modules/reputation/__tests__/review-normalize.test.mts

import { createHash } from "node:crypto";
import { REVIEW_PROVIDER_SCALES, baseProvider } from "./reputation-types.js";

export type NormalizeRatingInput = {
  rating: number;
  scaleMax: number;
};

export type NormalizedRating = {
  /** Nota sobre 10 con 1 decimal (10,0 admitido). */
  score10: number;
  /** Nota sobre 5 con 2 decimales: lo que se guarda en GuestReview.rating. */
  score5: number;
  ratingRaw: number;
  ratingScaleMax: number;
};

export type RatingNormalizationCode = "RATING_NOT_A_NUMBER" | "RATING_SCALE_INVALID" | "RATING_OUT_OF_RANGE";

/** Error tipado de normalización: `code` para el mapeo a REVIEW_IMPORT_INVALID. */
export class RatingNormalizationError extends Error {
  readonly code: RatingNormalizationCode;
  constructor(code: RatingNormalizationCode, message: string) {
    super(message);
    this.name = "RatingNormalizationError";
    this.code = code;
  }
}

/** Escalas admitidas cuando no la fija el proveedor (5 estrellas, 6 soles, 10 puntos, 100 %). */
export const KNOWN_SCALE_MAX = Object.freeze([5, 6, 10, 100] as const);

/** Redondeo half-up estable en decimal (evita 2,675 → 2,67 y 4,145 → 4,14). */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const text = String(value);
  if (text.includes("e")) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }
  const shifted = Number(`${text}e${decimals}`);
  return Number(`${Math.round(shifted)}e-${decimals}`);
}

export function round1(value: number): number {
  return roundTo(value, 1);
}

export function round2(value: number): number {
  return roundTo(value, 2);
}

/**
 * Normaliza una nota a la escala común. Lanza RatingNormalizationError cuando
 * la nota o la escala no son números finitos, la escala es ≤ 0 o la nota está
 * fuera de [0, scaleMax].
 */
export function normalizeRating(input: NormalizeRatingInput): NormalizedRating {
  const { rating, scaleMax } = input;
  if (typeof rating !== "number" || !Number.isFinite(rating)) {
    throw new RatingNormalizationError("RATING_NOT_A_NUMBER", "La nota no es un número.");
  }
  if (typeof scaleMax !== "number" || !Number.isFinite(scaleMax) || scaleMax <= 0) {
    throw new RatingNormalizationError("RATING_SCALE_INVALID", "La escala de la nota no es válida (debe ser mayor que 0).");
  }
  if (rating < 0 || rating > scaleMax) {
    throw new RatingNormalizationError("RATING_OUT_OF_RANGE", `La nota ${rating} está fuera del rango 0-${scaleMax}.`);
  }
  const score10 = round1((rating / scaleMax) * 10);
  return {
    score10,
    score5: round2(score10 / 2),
    ratingRaw: rating,
    ratingScaleMax: scaleMax
  };
}

/** Variante sin excepción: `null` cuando la nota no se puede normalizar. */
export function normalizeRatingOrNull(input: { rating: number | null | undefined; scaleMax: number | null | undefined }): NormalizedRating | null {
  if (typeof input.rating !== "number" || typeof input.scaleMax !== "number") return null;
  try {
    return normalizeRating({ rating: input.rating, scaleMax: input.scaleMax });
  } catch (error) {
    if (error instanceof RatingNormalizationError) return null;
    throw error;
  }
}

/** Escala del proveedor (acepta `google_demo`); `null` cuando viaja por fila (csv, email, demo). */
export function scaleFor(provider: string): number | null {
  const base = baseProvider(provider);
  return base ? REVIEW_PROVIDER_SCALES[base] : null;
}

/** Nota sobre 5 (GuestReview.rating) → nota sobre 10 (compatibilidad con filas antiguas). */
export function score5ToScore10(score5: number | null | undefined): number | null {
  if (typeof score5 !== "number" || !Number.isFinite(score5)) return null;
  return round1(Math.min(5, Math.max(0, score5)) * 2);
}

// ---------------------------------------------------------------------------
// Hash de contenido y referencia externa
// ---------------------------------------------------------------------------

export type ContentHashInput = {
  source: string;
  externalId?: string | null;
  authorDisplayName?: string | null;
  receivedAt?: string | Date | null;
  title?: string | null;
  body?: string | null;
  ratingRaw?: number | null;
};

/** Texto comparable: NFC, sin espacios repetidos, minúsculas. */
function canonicalText(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

function canonicalDate(value: string | Date | null | undefined): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value !== "string" || !value.trim()) return "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value.trim();
}

/**
 * sha256 (40 hex) de `source | id-o-autor+fecha | título | cuerpo | nota`.
 * La identidad usa el id del portal si existe y, si no, autor + fecha.
 */
export function contentHash(input: ContentHashInput): string {
  const identity = input.externalId?.trim()
    ? `id:${input.externalId.trim()}`
    : `af:${canonicalText(input.authorDisplayName)}|${canonicalDate(input.receivedAt)}`;
  const parts = [
    canonicalText(input.source),
    identity,
    canonicalText(input.title),
    canonicalText(input.body),
    typeof input.ratingRaw === "number" && Number.isFinite(input.ratingRaw) ? String(input.ratingRaw) : ""
  ];
  return createHash("sha256").update(parts.join(""), "utf8").digest("hex").slice(0, 40);
}

export type ExternalReferenceInput = ContentHashInput;

/** Clave natural de la reseña: id del portal o `h:` + hash de contenido. */
export function externalReferenceFor(item: ExternalReferenceInput): string {
  const externalId = item.externalId?.trim();
  if (externalId) return externalId;
  return `h:${contentHash({ ...item, externalId: null })}`;
}

// ---------------------------------------------------------------------------
// Minimización del autor
// ---------------------------------------------------------------------------

const NAME_PARTICLES = new Set(["de", "del", "la", "las", "los", "da", "das", "do", "dos", "van", "von", "der", "den", "di", "du", "le", "y", "e"]);

/**
 * «María García López» → «María G.»; una sola palabra se conserva; vacío → undefined.
 * Un pseudónimo con número («Viajero 12», «Guest 4», «Traveler_7») se conserva
 * entero: el número no identifica a nadie y distingue a los autores demo.
 * Nunca se guarda el nombre completo del autor (diseño §3.4).
 */
export function minimizeAuthorName(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const words = value
    .replace(/[^\p{L}\p{M}\p{N}'’\- ]+/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return undefined;
  const first = words[0] as string;
  const rest = words.slice(1).filter((word) => !NAME_PARTICLES.has(word.toLowerCase()));
  const surname = rest[0];
  if (!surname) return first.slice(0, 40);
  if (/^\p{N}+$/u.test(surname)) return `${first.slice(0, 40)} ${surname.slice(0, 6)}`;
  return `${first.slice(0, 40)} ${surname.charAt(0).toUpperCase()}.`;
}
