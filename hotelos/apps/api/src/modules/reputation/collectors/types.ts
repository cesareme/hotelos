// Reputación · Tanda T8 · lote T8-B — contrato común de los colectores de
// reseñas (apps/api/src/modules/reputation/collectors/types.ts).
//
// Reglas del fichero:
//   · solo tipos e interfaces: sin Prisma, sin variables de entorno, sin red;
//   · un colector NUNCA hace red por su cuenta: solo llama al `fetchImpl` que
//     el servicio le inyecta en `ctx` (y sin él responde con estado honesto);
//   · las credenciales llegan ya descifradas en `source.credentials` y las
//     opciones de aplicación (ids de cliente OAuth) en `source.options`; el
//     colector no las loguea ni las devuelve en ningún resultado;
//   · la forma normalizada `NormalizedReview` es la única salida: el servicio
//     de sincronización la convierte en GuestReview + ReviewMeta.

import type {
  ReviewProvider,
  ReviewSourceCapabilities,
  ReviewSourceConfig,
  ReviewSourceMode,
  ReviewSourceStatus
} from "../reputation-types.js";

/** Subpuntuaciones que publica un portal (escala del portal; Booking 1-10). */
export type PortalSubscores = {
  clean?: number | null;
  staff?: number | null;
  location?: number | null;
  value?: number | null;
  facilities?: number | null;
  comfort?: number | null;
  wifi?: number | null;
};

/** Respuesta ya publicada en el portal, tal como la devuelve su API. */
export type PortalReply = {
  body: string;
  repliedAt?: string;
};

/** Reseña normalizada que devuelve cualquier colector o parser (fechas ISO). */
export type NormalizedReview = {
  /** Id de la reseña en el portal; sin él, externalReferenceFor() deriva `h:<hash>`. */
  externalId?: string;
  /** Fecha de publicación en el portal (ISO). */
  receivedAt: string;
  /** Nota original del portal; `null` cuando la reseña solo trae texto. */
  ratingRaw: number | null;
  /** Escala máxima de la nota (5, 6, 10…); `null` sin nota. */
  ratingScaleMax: number | null;
  title?: string;
  body?: string;
  /** `false` cuando solo llega un extracto (correo de notificación). */
  bodyComplete: boolean;
  /** Código ISO 639-1 (`es`, `en`…) o `und`. */
  language?: string;
  /** Nombre minimizado del autor («Nombre A.»); nunca foto ni enlace de perfil. */
  authorDisplayName?: string;
  /** País ISO 3166-1 alfa-2 del autor. */
  authorCountry?: string;
  /** Enlace a la reseña en el portal («abrir en el portal»). */
  portalUrl?: string;
  subscores?: PortalSubscores;
  /** Si el portal admite publicar la respuesta por API desde aquí. */
  replyCapability: boolean;
  /** Portal real de una reseña llegada por correo o CSV (la fuente es `email`/`csv`). */
  portalProvider?: ReviewProvider;
  portalReply?: PortalReply;
  /** Última edición en el portal (ISO), si la API lo informa. */
  updatedAtSource?: string;
};

/** Credenciales descifradas de una fuente (nunca salen del proceso). */
export type CollectorCredentials = {
  accessToken?: string;
  refreshToken?: string;
  /** Token de partner (Booking/Expedia) cuando exista un channel manager. */
  partnerToken?: string;
  expiresAt?: string;
};

/** Opciones de aplicación que el servicio inyecta desde su contrato de entorno. */
export type CollectorOptions = {
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri?: string;
};

/** Fuente tal como la ve el colector: configuración leída + credenciales descifradas. */
export type CollectorSource = {
  propertyId: string;
  sourceId?: string;
  provider: ReviewProvider;
  config: ReviewSourceConfig;
  credentials?: CollectorCredentials | null;
  options?: CollectorOptions;
};

export type CollectorState = {
  status: ReviewSourceStatus;
  /** Motivo en español cuando el estado no es `connected`. */
  reason?: string;
};

/** Respuesta mínima que necesita un colector del cliente HTTP inyectado. */
export type FetchLikeResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type FetchLikeInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

export type CollectorLogLevel = "info" | "warn" | "error";

/** Correo de notificación ya leído por el servicio de buzones (entrada del colector `email`). */
export type InboundEmailLike = {
  messageId?: string | null;
  fromAddress?: string | null;
  subject?: string | null;
  snippet?: string | null;
  bodyText?: string | null;
  receivedAt?: string | Date | null;
};

export type CollectorContext = {
  /** Cliente HTTP inyectado; sin él ningún colector hace red. */
  fetchImpl?: FetchLike;
  now: Date;
  log?: (level: CollectorLogLevel, message: string, meta?: Record<string, unknown>) => void;
  /** Correos ya leídos por el servicio (solo los usa el colector `email`). */
  emails?: ReadonlyArray<InboundEmailLike>;
};

export type FetchSinceInput = {
  source: CollectorSource;
  /** Traer reseñas publicadas o editadas desde esta fecha (inclusive). */
  since: Date;
  ctx: CollectorContext;
};

export type FetchSinceResult = {
  items: NormalizedReview[];
  /** Cursor a persistir en `ReviewSourceConfig.cursor` (nunca tokens). */
  cursor?: Record<string, unknown>;
  status: ReviewSourceStatus;
  error?: string;
};

export type ReplyInput = {
  source: CollectorSource;
  externalId: string;
  body: string;
  ctx: CollectorContext;
};

export type ReplyResult = {
  ok: boolean;
  /** Estado devuelto por el portal (`published`, `pending_moderation`…). */
  externalState?: string;
  error?: string;
};

export interface ReviewCollector {
  readonly provider: ReviewProvider;
  readonly mode: ReviewSourceMode;
  readonly capabilities: ReviewSourceCapabilities;
  /** Estado honesto de la fuente sin hacer red. */
  describeState(source: CollectorSource): CollectorState;
  fetchSince(input: FetchSinceInput): Promise<FetchSinceResult>;
  reply?(input: ReplyInput): Promise<ReplyResult>;
}
