// Reputación · Tanda T8 · lote T8-B — colector `email` (correos de
// notificación de Tripadvisor, HolidayCheck, Booking y Expedia)
// (apps/api/src/modules/reputation/collectors/email-notification.ts).
//
// El colector NO lee buzones: recibe en `ctx.emails` los InboundEmail que
// el servicio de buzones ya ha leído (Gmail/Microsoft OAuth o correo
// manual), los clasifica con classifyInboundEmail() y parsea los de reseña
// con parseReviewNotification(). Sin Prisma, sin variables de entorno, sin
// red. `ReviewSourceConfig.externalAccountId` guarda el id de la conexión
// de correo hasta que el parche T8-L0 añada `emailConnectionId`.

import { DEFAULT_SOURCE_CAPABILITIES, isReviewProvider, type ReviewProvider } from "../reputation-types.js";
import { classifyInboundEmailDetailed, parseReviewNotification } from "../review-email.parser.js";
import type { CollectorSource, CollectorState, FetchSinceInput, FetchSinceResult, InboundEmailLike, NormalizedReview, ReviewCollector } from "./types.js";

export const EMAIL_NO_MAILBOX_REASON = "Sin buzón conectado: vincula una conexión de correo (Gmail o Microsoft) en Ajustes de fuentes.";
export const EMAIL_NO_INPUT_REASON = "El servicio de buzones no ha entregado correos en este tick.";

/** Portales que llegan por correo (`email` genérico acepta cualquiera). */
export const EMAIL_PROVIDERS: readonly ReviewProvider[] = Object.freeze(["email", "tripadvisor", "holidaycheck", "booking", "expedia", "google"]);

function toTime(value: string | Date | null | undefined): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type EmailCollectionResult = {
  items: NormalizedReview[];
  /** Correos que no eran de reseña (o de otro portal) y se dejaron pasar. */
  skipped: number;
};

/** Convierte correos ya leídos en reseñas del portal indicado (`email` = cualquiera). */
export function collectReviewsFromEmails(emails: ReadonlyArray<InboundEmailLike>, provider: ReviewProvider, since: Date, now: Date): EmailCollectionResult {
  const items: NormalizedReview[] = [];
  let skipped = 0;
  for (const email of emails) {
    const classification = classifyInboundEmailDetailed(email);
    if (classification.kind !== "review_notification" || !classification.provider) {
      skipped += 1;
      continue;
    }
    if (provider !== "email" && classification.provider !== provider) {
      skipped += 1;
      continue;
    }
    const receivedMs = toTime(email.receivedAt);
    if (receivedMs !== null && receivedMs < since.getTime()) {
      skipped += 1;
      continue;
    }
    const review = parseReviewNotification(email, classification.provider, { now });
    if (!review) {
      skipped += 1;
      continue;
    }
    items.push(review);
  }
  return { items, skipped };
}

export class EmailNotificationCollector implements ReviewCollector {
  readonly provider: ReviewProvider;
  readonly mode = "email" as const;
  readonly capabilities = DEFAULT_SOURCE_CAPABILITIES.email;

  constructor(provider: ReviewProvider = "email") {
    this.provider = isReviewProvider(provider) && EMAIL_PROVIDERS.includes(provider) ? provider : "email";
  }

  describeState(source: CollectorSource): CollectorState {
    if (!source.config.externalAccountId) return { status: "pending", reason: EMAIL_NO_MAILBOX_REASON };
    return { status: "connected" };
  }

  async fetchSince(input: FetchSinceInput): Promise<FetchSinceResult> {
    const state = this.describeState(input.source);
    if (state.status !== "connected") {
      return { items: [], status: state.status, ...(state.reason ? { error: state.reason } : {}) };
    }
    const emails = input.ctx.emails;
    if (!emails) return { items: [], status: "degraded", error: EMAIL_NO_INPUT_REASON };
    const { items, skipped } = collectReviewsFromEmails(emails, this.provider, input.since, input.ctx.now);
    input.ctx.log?.("info", "[reputation.email] correos procesados", { provider: this.provider, reviews: items.length, skipped });
    return { items, status: "connected", cursor: { lastCheckedAt: input.ctx.now.toISOString(), processed: emails.length } };
  }
}

export const emailNotificationCollector = new EmailNotificationCollector("email");

export function createEmailNotificationCollector(provider: ReviewProvider): EmailNotificationCollector {
  return new EmailNotificationCollector(provider);
}
