// Reputación · Tanda T8 · lote T8-B — colector `google` (Business Profile
// API v4) (apps/api/src/modules/reputation/collectors/google-business-profile.ts).
//
// Reglas del fichero:
//   · cliente v4 con `fetchImpl` INYECTADO: sin fetchImpl nunca hace red y
//     responde con estado honesto; sin credenciales de aplicación (id de
//     cliente OAuth) → `unavailable` «Google Business Profile: sin
//     credenciales (GOOGLE_BUSINESS_CLIENT_ID)»; con id de cliente pero sin
//     token del hotel → `pending` (autorizar OAuth business.manage); con
//     token de acceso → llama a reviews.list paginado por updateTime desc;
//   · buildAuthorizeUrl() es puro; el intercambio del código y el refresh
//     llegan en T8-L5 (google-oauth.ts);
//   · tope de GOOGLE_MAX_PAGES páginas por vuelta (corrección ronda 1, BD-10):
//     si quedan páginas, la vuelta devuelve `degraded` con el motivo y el
//     `nextPageToken` en el cursor; el tick la registra como `partial` (sin
//     avanzar lastSuccessAt) y la SIGUIENTE vuelta retoma desde ese token
//     (`config.cursor.nextPageToken`); si Google rechaza el token (400), se
//     reinicia desde la primera página en la misma vuelta;
//   · sin Prisma, sin variables de entorno (las credenciales vienen en
//     `source.credentials` y `source.options`).

import { DEFAULT_SOURCE_CAPABILITIES } from "../reputation-types.js";
import { minimizeAuthorName } from "../review-normalize.js";
import type {
  CollectorSource,
  CollectorState,
  FetchLike,
  FetchSinceInput,
  FetchSinceResult,
  NormalizedReview,
  ReplyInput,
  ReplyResult,
  ReviewCollector
} from "./types.js";

export const GOOGLE_API_BASE = "https://mybusiness.googleapis.com/v4";
export const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/business.manage";
export const GOOGLE_PAGE_SIZE = 50;
export const GOOGLE_MAX_PAGES = 10;
export const GOOGLE_SCALE_MAX = 5;

export const GOOGLE_NO_CLIENT_REASON = "Google Business Profile: sin credenciales (GOOGLE_BUSINESS_CLIENT_ID)";
export const GOOGLE_NOT_AUTHORIZED_REASON = "Pendiente de autorizar la cuenta de Google del hotel (OAuth business.manage) desde Ajustes de fuentes.";
export const GOOGLE_NO_LOCATION_REASON = "Falta el identificador de ubicación de Google (accounts/{a}/locations/{l}).";
export const GOOGLE_NO_FETCH_REASON = "Sin cliente HTTP inyectado: el colector no hace red por su cuenta.";
export const GOOGLE_TOKEN_EXPIRED_REASON = "Token de acceso de Google ausente o caducado: reautorizar (el refresco automático llega en T8-L5).";
export const GOOGLE_MORE_PAGES_REASON = `Quedan páginas por leer (tope de ${GOOGLE_MAX_PAGES} páginas por vuelta): la siguiente vuelta continúa desde el cursor guardado.`;

/** `starRating` del API → 1-5. */
const STAR_RATING: Readonly<Record<string, number>> = Object.freeze({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 });

/** Forma (parcial) de una reseña de la Business Profile API v4. */
export type GoogleApiReview = {
  name?: string;
  reviewId?: string;
  reviewer?: { displayName?: string | null; isAnonymous?: boolean | null } | null;
  starRating?: string | null;
  comment?: string | null;
  createTime?: string | null;
  updateTime?: string | null;
  reviewReply?: { comment?: string | null; updateTime?: string | null } | null;
};

export type GoogleListReviewsResponse = {
  reviews?: GoogleApiReview[];
  nextPageToken?: string;
  averageRating?: number;
  totalReviewCount?: number;
};

export type BuildAuthorizeUrlInput = {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
  loginHint?: string;
};

/** URL de autorización OAuth (offline + consent para obtener refresh token). Puro. */
export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const url = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.scope ?? GOOGLE_OAUTH_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", input.state);
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

/** Error tipado del cliente (código HTTP y cuerpo recortado, sin token). */
export class GoogleApiError extends Error {
  readonly status: number;
  readonly code: "GOOGLE_UNAUTHORIZED" | "GOOGLE_FORBIDDEN" | "GOOGLE_NOT_FOUND" | "GOOGLE_RATE_LIMITED" | "GOOGLE_HTTP_ERROR";
  constructor(status: number, detail: string) {
    super(`Google Business Profile API ${status}: ${detail}`);
    this.name = "GoogleApiError";
    this.status = status;
    this.code = status === 401 ? "GOOGLE_UNAUTHORIZED" : status === 403 ? "GOOGLE_FORBIDDEN" : status === 404 ? "GOOGLE_NOT_FOUND" : status === 429 ? "GOOGLE_RATE_LIMITED" : "GOOGLE_HTTP_ERROR";
  }
}

async function readError(response: { status: number; text(): Promise<string> }): Promise<GoogleApiError> {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    detail = "sin cuerpo";
  }
  return new GoogleApiError(response.status, detail);
}

export type ListReviewsInput = {
  /** `accounts/{accountId}/locations/{locationId}` */
  locationName: string;
  accessToken: string;
  fetchImpl: FetchLike;
  pageToken?: string;
  pageSize?: number;
};

/** `GET /v4/{locationName}/reviews?pageSize=50&orderBy=updateTime desc`. */
export async function listReviews(input: ListReviewsInput): Promise<GoogleListReviewsResponse> {
  const url = new URL(`${GOOGLE_API_BASE}/${input.locationName}/reviews`);
  url.searchParams.set("pageSize", String(input.pageSize ?? GOOGLE_PAGE_SIZE));
  url.searchParams.set("orderBy", "updateTime desc");
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  const response = await input.fetchImpl(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${input.accessToken}`, Accept: "application/json" }
  });
  if (!response.ok) throw await readError(response);
  const json = (await response.json()) as GoogleListReviewsResponse | null;
  return json ?? {};
}

export type UpdateReplyInput = {
  /** `accounts/{a}/locations/{l}/reviews/{r}` */
  reviewName: string;
  accessToken: string;
  comment: string;
  fetchImpl: FetchLike;
};

/** `PUT /v4/{reviewName}/reply { comment }`. */
export async function updateReply(input: UpdateReplyInput): Promise<{ comment: string; updateTime?: string }> {
  const response = await input.fetchImpl(`${GOOGLE_API_BASE}/${input.reviewName}/reply`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ comment: input.comment })
  });
  if (!response.ok) throw await readError(response);
  const json = (await response.json()) as { comment?: string; updateTime?: string } | null;
  return { comment: json?.comment ?? input.comment, ...(json?.updateTime ? { updateTime: json.updateTime } : {}) };
}

function toIso(value: string | null | undefined, fallback: Date): string {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return fallback.toISOString();
}

/** Google API → NormalizedReview (autor minimizado; sin foto ni perfil). */
export function normalizeGoogleReview(raw: GoogleApiReview, now: Date): NormalizedReview {
  const rating = raw.starRating ? (STAR_RATING[raw.starRating.toUpperCase()] ?? null) : null;
  const externalId = raw.reviewId?.trim() || raw.name?.split("/reviews/")[1]?.trim();
  const body = raw.comment?.trim();
  const author = raw.reviewer?.isAnonymous ? undefined : minimizeAuthorName(raw.reviewer?.displayName ?? undefined);
  const replyText = raw.reviewReply?.comment?.trim();
  return {
    ...(externalId ? { externalId } : {}),
    receivedAt: toIso(raw.createTime, now),
    ratingRaw: rating,
    ratingScaleMax: rating === null ? null : GOOGLE_SCALE_MAX,
    ...(body ? { body } : {}),
    bodyComplete: true,
    ...(author ? { authorDisplayName: author } : {}),
    replyCapability: true,
    ...(replyText ? { portalReply: { body: replyText, ...(raw.reviewReply?.updateTime ? { repliedAt: toIso(raw.reviewReply.updateTime, now) } : {}) } } : {}),
    ...(raw.updateTime ? { updatedAtSource: toIso(raw.updateTime, now) } : {})
  };
}

export class GoogleBusinessProfileCollector implements ReviewCollector {
  readonly provider = "google" as const;
  readonly mode = "api" as const;
  readonly capabilities = DEFAULT_SOURCE_CAPABILITIES.google;

  describeState(source: CollectorSource): CollectorState {
    if (!source.options?.googleClientId) return { status: "unavailable", reason: GOOGLE_NO_CLIENT_REASON };
    const credentials = source.credentials;
    if (!credentials?.accessToken && !credentials?.refreshToken) return { status: "pending", reason: GOOGLE_NOT_AUTHORIZED_REASON };
    if (!source.config.externalLocationId) return { status: "pending", reason: GOOGLE_NO_LOCATION_REASON };
    return { status: "connected" };
  }

  async fetchSince(input: FetchSinceInput): Promise<FetchSinceResult> {
    const state = this.describeState(input.source);
    if (state.status !== "connected") {
      return { items: [], status: state.status, ...(state.reason ? { error: state.reason } : {}) };
    }
    const fetchImpl = input.ctx.fetchImpl;
    if (!fetchImpl) return { items: [], status: "degraded", error: GOOGLE_NO_FETCH_REASON };
    const accessToken = input.source.credentials?.accessToken;
    if (!accessToken) return { items: [], status: "degraded", error: GOOGLE_TOKEN_EXPIRED_REASON };
    const locationName = input.source.config.externalLocationId as string;
    const sinceMs = input.since.getTime();
    const items: NormalizedReview[] = [];
    // Retoma desde el token de la vuelta anterior si aquella quedó parcial por el tope de páginas.
    const resumeToken = typeof input.source.config.cursor?.nextPageToken === "string" && input.source.config.cursor.nextPageToken.trim() ? (input.source.config.cursor.nextPageToken as string) : undefined;
    let pageToken: string | undefined = resumeToken;
    let resuming = resumeToken !== undefined;
    let pages = 0;
    let reachedSince = false;
    try {
      do {
        let page: GoogleListReviewsResponse;
        try {
          page = await listReviews({ locationName, accessToken, fetchImpl, pageToken });
        } catch (error) {
          // Token de continuación rechazado (caducado): se reinicia desde la primera página en esta misma vuelta.
          if (resuming && error instanceof GoogleApiError && error.status === 400) {
            input.ctx.log?.("warn", "[reputation.google] cursor de continuación rechazado: se reinicia desde la primera página", { status: error.status });
            resuming = false;
            pageToken = undefined;
            page = await listReviews({ locationName, accessToken, fetchImpl });
          } else {
            throw error;
          }
        }
        resuming = false;
        pages += 1;
        for (const raw of page.reviews ?? []) {
          const normalized = normalizeGoogleReview(raw, input.ctx.now);
          const updatedMs = Date.parse(normalized.updatedAtSource ?? normalized.receivedAt);
          if (Number.isFinite(updatedMs) && updatedMs < sinceMs) {
            reachedSince = true;
            break;
          }
          items.push(normalized);
        }
        pageToken = reachedSince ? undefined : page.nextPageToken;
      } while (pageToken && pages < GOOGLE_MAX_PAGES);
    } catch (error) {
      if (error instanceof GoogleApiError) {
        const status = error.code === "GOOGLE_UNAUTHORIZED" || error.code === "GOOGLE_FORBIDDEN" ? "error" : "degraded";
        input.ctx.log?.("warn", "[reputation.google] fallo del API", { code: error.code, status: error.status });
        return { items, status, error: error.message };
      }
      throw error;
    }
    if (pageToken) {
      // Tope alcanzado con páginas pendientes: lectura parcial honesta; el cursor guarda el token para la siguiente vuelta.
      input.ctx.log?.("warn", "[reputation.google] tope de páginas alcanzado", { pages, items: items.length });
      return { items, status: "degraded", error: GOOGLE_MORE_PAGES_REASON, cursor: { lastSyncAt: input.ctx.now.toISOString(), pages, nextPageToken: pageToken } };
    }
    return {
      items,
      status: "connected",
      cursor: { lastSyncAt: input.ctx.now.toISOString(), pages }
    };
  }

  async reply(input: ReplyInput): Promise<ReplyResult> {
    const state = this.describeState(input.source);
    if (state.status !== "connected") return { ok: false, error: state.reason ?? "Fuente no conectada." };
    const fetchImpl = input.ctx.fetchImpl;
    if (!fetchImpl) return { ok: false, error: GOOGLE_NO_FETCH_REASON };
    const accessToken = input.source.credentials?.accessToken;
    if (!accessToken) return { ok: false, error: GOOGLE_TOKEN_EXPIRED_REASON };
    const reviewName = `${input.source.config.externalLocationId}/reviews/${input.externalId}`;
    try {
      const result = await updateReply({ reviewName, accessToken, comment: input.body, fetchImpl });
      return { ok: true, externalState: result.updateTime ? "published" : "accepted" };
    } catch (error) {
      if (error instanceof GoogleApiError) return { ok: false, error: error.message };
      throw error;
    }
  }
}

export const googleBusinessProfileCollector = new GoogleBusinessProfileCollector();
