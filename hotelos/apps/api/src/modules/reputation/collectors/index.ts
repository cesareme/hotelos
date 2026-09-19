// Reputación · Tanda T8 · lote T8-B — registro de colectores
// (apps/api/src/modules/reputation/collectors/index.ts).
//
// collectorFor(provider, mode) devuelve el colector honesto de cada fuente
// (o `null` si la combinación no existe). Ningún colector hace red sin
// `fetchImpl` inyectado. Sin Prisma, sin variables de entorno.

import { baseProvider, type ReviewProvider, type ReviewSourceMode } from "../reputation-types.js";
import { bookingReviewApiCollector } from "./booking-review-api.js";
import { csvImportCollector } from "./csv-import.js";
import { demoCollector } from "./demo.js";
import { EMAIL_PROVIDERS, createEmailNotificationCollector, emailNotificationCollector } from "./email-notification.js";
import { expediaLodgingSupplyCollector } from "./expedia-lodging-supply.js";
import { googleBusinessProfileCollector } from "./google-business-profile.js";
import type { CollectorSource, CollectorState, ReviewCollector } from "./types.js";

export * from "./types.js";
export { CsvImportCollector, csvImportCollector, CSV_IMPORT_REASON } from "./csv-import.js";
export { DemoCollector, demoCollector, DEMO_REASON } from "./demo.js";
export { EmailNotificationCollector, emailNotificationCollector, createEmailNotificationCollector, collectReviewsFromEmails, EMAIL_PROVIDERS, EMAIL_NO_MAILBOX_REASON, EMAIL_NO_INPUT_REASON } from "./email-notification.js";
export {
  GoogleBusinessProfileCollector,
  googleBusinessProfileCollector,
  GoogleApiError,
  buildAuthorizeUrl,
  listReviews,
  updateReply,
  normalizeGoogleReview,
  GOOGLE_NO_CLIENT_REASON,
  GOOGLE_NOT_AUTHORIZED_REASON,
  GOOGLE_NO_LOCATION_REASON,
  GOOGLE_NO_FETCH_REASON,
  GOOGLE_TOKEN_EXPIRED_REASON,
  GOOGLE_MORE_PAGES_REASON,
  GOOGLE_MAX_PAGES,
  GOOGLE_OAUTH_SCOPE
} from "./google-business-profile.js";
export { BookingReviewApiCollector, bookingReviewApiCollector, normalizeBookingReview, BOOKING_UNAVAILABLE_REASON } from "./booking-review-api.js";
export { ExpediaLodgingSupplyCollector, expediaLodgingSupplyCollector, EXPEDIA_UNAVAILABLE_REASON } from "./expedia-lodging-supply.js";

const EMAIL_BY_PROVIDER = new Map<ReviewProvider, ReviewCollector>();

/** Colector para (proveedor, modo); acepta `google_demo` → google. `null` si no existe. */
export function collectorFor(provider: string, mode: ReviewSourceMode): ReviewCollector | null {
  const base = baseProvider(provider);
  if (!base) return null;
  switch (mode) {
    case "api":
      if (base === "google") return googleBusinessProfileCollector;
      if (base === "booking") return bookingReviewApiCollector;
      if (base === "expedia") return expediaLodgingSupplyCollector;
      return null;
    case "email": {
      if (!EMAIL_PROVIDERS.includes(base)) return null;
      if (base === "email") return emailNotificationCollector;
      const cached = EMAIL_BY_PROVIDER.get(base);
      if (cached) return cached;
      const created = createEmailNotificationCollector(base);
      EMAIL_BY_PROVIDER.set(base, created);
      return created;
    }
    case "csv":
    case "manual":
      return csvImportCollector;
    case "demo":
      return demoCollector;
    default:
      return null;
  }
}

/** Los colectores base (uno por vía), en orden de presentación. */
export const REVIEW_COLLECTORS: readonly ReviewCollector[] = Object.freeze([
  googleBusinessProfileCollector,
  bookingReviewApiCollector,
  expediaLodgingSupplyCollector,
  emailNotificationCollector,
  csvImportCollector,
  demoCollector
]);

/** Estado honesto de una fuente sin hacer red; `unavailable` si no hay colector. */
export function describeSourceState(source: CollectorSource, mode: ReviewSourceMode): CollectorState {
  const collector = collectorFor(source.provider, mode);
  if (!collector) return { status: "unavailable", reason: `No existe colector para ${source.provider} en modo ${mode}.` };
  return collector.describeState(source);
}
