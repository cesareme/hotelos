// Reputación · Tanda T8 · lote T8-B — colector `booking` (Guest Review API)
// (apps/api/src/modules/reputation/collectors/booking-review-api.ts).
//
// Estado honesto: Booking.com solo da acceso al Review API a connectivity
// partners (y pausa nuevos partners); sin un channel manager que lo exponga
// la fuente es `unavailable` y fetchSince devuelve [] SIN hacer red. El
// normalizador de la forma documentada del API (headline/positive/negative,
// scoring.*, reviewer, review_score) queda listo para T8-L5. Sin Prisma,
// sin variables de entorno, sin red.

import { DEFAULT_SOURCE_CAPABILITIES } from "../reputation-types.js";
import { minimizeAuthorName } from "../review-normalize.js";
import type { CollectorSource, CollectorState, FetchSinceInput, FetchSinceResult, NormalizedReview, ReviewCollector } from "./types.js";

export const BOOKING_UNAVAILABLE_REASON = "Booking solo da acceso a connectivity partners; indica tu channel manager";
export const BOOKING_SCALE_MAX = 10;

/** Forma (parcial) de una reseña del Guest Review API de Booking.com. */
export type BookingApiReview = {
  review_id?: string | number;
  created_at?: string;
  updated_at?: string;
  headline?: string | null;
  positive?: string | null;
  negative?: string | null;
  language_code?: string | null;
  review_score?: number | string | null;
  scoring?: {
    clean?: number | null;
    comfort?: number | null;
    location?: number | null;
    facilities?: number | null;
    staff?: number | null;
    value_for_money?: number | null;
    wifi?: number | null;
  } | null;
  reviewer?: { name?: string | null; country_code?: string | null } | null;
  reply?: { text?: string | null; created_at?: string | null } | null;
};

function toNumber(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIso(value: string | null | undefined, fallback: Date): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return fallback.toISOString();
}

/** Booking API → NormalizedReview (positivo/negativo en dos párrafos etiquetados). */
export function normalizeBookingReview(raw: BookingApiReview, now: Date): NormalizedReview {
  const positive = raw.positive?.trim();
  const negative = raw.negative?.trim();
  const parts: string[] = [];
  if (positive) parts.push(`Lo mejor: ${positive}`);
  if (negative) parts.push(`A mejorar: ${negative}`);
  const body = parts.length > 0 ? parts.join("\n\n") : undefined;
  const title = raw.headline?.trim();
  const rating = toNumber(raw.review_score);
  const author = minimizeAuthorName(raw.reviewer?.name ?? undefined);
  const country = raw.reviewer?.country_code?.trim().toUpperCase();
  const replyText = raw.reply?.text?.trim();
  const scoring = raw.scoring ?? undefined;
  return {
    ...(raw.review_id !== undefined && raw.review_id !== null ? { externalId: String(raw.review_id) } : {}),
    receivedAt: toIso(raw.created_at, now),
    ratingRaw: rating,
    ratingScaleMax: rating === null ? null : BOOKING_SCALE_MAX,
    ...(title ? { title } : {}),
    ...(body ? { body } : {}),
    bodyComplete: true,
    ...(raw.language_code ? { language: raw.language_code.toLowerCase().slice(0, 2) } : {}),
    ...(author ? { authorDisplayName: author } : {}),
    ...(country && /^[A-Z]{2}$/.test(country) ? { authorCountry: country } : {}),
    ...(scoring
      ? {
          subscores: {
            clean: scoring.clean ?? null,
            comfort: scoring.comfort ?? null,
            location: scoring.location ?? null,
            facilities: scoring.facilities ?? null,
            staff: scoring.staff ?? null,
            value: scoring.value_for_money ?? null,
            wifi: scoring.wifi ?? null
          }
        }
      : {}),
    replyCapability: true,
    ...(replyText ? { portalReply: { body: replyText, ...(raw.reply?.created_at ? { repliedAt: toIso(raw.reply.created_at, now) } : {}) } } : {}),
    ...(raw.updated_at ? { updatedAtSource: toIso(raw.updated_at, now) } : {})
  };
}

export class BookingReviewApiCollector implements ReviewCollector {
  readonly provider = "booking" as const;
  readonly mode = "api" as const;
  readonly capabilities = DEFAULT_SOURCE_CAPABILITIES.booking;

  describeState(source: CollectorSource): CollectorState {
    if (source.credentials?.partnerToken) {
      return { status: "pending", reason: "Token de partner recibido; el cliente del Review API llega en T8-L5 (hoy no sincroniza)." };
    }
    return { status: "unavailable", reason: BOOKING_UNAVAILABLE_REASON };
  }

  async fetchSince(input: FetchSinceInput): Promise<FetchSinceResult> {
    const state = this.describeState(input.source);
    return { items: [], status: state.status, ...(state.reason ? { error: state.reason } : {}) };
  }
}

export const bookingReviewApiCollector = new BookingReviewApiCollector();
