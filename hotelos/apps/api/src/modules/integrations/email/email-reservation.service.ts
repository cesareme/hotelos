// Email → AI → reservation pipeline.
//
// Connect a mailbox (Gmail / Microsoft Graph / IMAP / manual), read inbound
// emails, let the AI extract a reservation draft, and route EVERY draft through
// the human-review queue (HITL) before a real reservation is created.
//
// Honest-by-default, mirroring the project's other AI features: real provider
// fetch is gated by OAuth env credentials; without them the "manual" connector
// (paste an email) exercises the identical extract → review → create path, and
// providers light up automatically once credentials are configured.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import type { UserContext } from "../../../lib/demo-store.js";
import { requirePermissions } from "../../auth/auth.service.js";
import { recordAuditEvent } from "../../audit/audit.service.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../../lib/http-error.js";
import { parseReservationRequest } from "../../pms/reservation-agent.service.js";
import { createReservation } from "../../pms/pms.service.js";
import { enqueueReview, approveReview, rejectReview } from "../../ai-operations/human-review.service.js";
// OPERA Cloud · modo sombra (Tanda 7b · L3): un buzón con propósito `pms_shadow`
// entrega cada adjunto (.csv/.txt/.xml/.xlsx ≤ 5 MiB) al ingest del modo sombra en
// vez de extraer una reserva con IA; el HITL no interviene y el adjunto no se guarda.
import { PMS_SHADOW_MAX_FILE_BYTES } from "@hotelos/shared";
import { PMS_SHADOW_ATTACHMENT_EXTENSIONS, addDaysIso, attachmentExtension, classifyFeed, localDateTime, scheduleFeedsOf, systemContext } from "../../pms-shadow/pms-shadow.rules.js";
import { createAlertIfOpen, findProfile, ingestPmsShadowFile } from "../../pms-shadow/pms-shadow.service.js";

const PROVIDERS = ["gmail", "microsoft", "imap", "manual"] as const;
type Provider = (typeof PROVIDERS)[number];

/** Propósito del buzón (`configJson.purpose`): extraer reservas con IA (defecto) o alimentar el modo sombra OPERA. */
export const EMAIL_PURPOSES = ["reservation_ai", "pms_shadow"] as const;
export type EmailPurpose = (typeof EMAIL_PURPOSES)[number];

/** Adjunto de un correo: metadatos y descarga PEREZOSA (solo se baja lo que pasa el filtro). */
export type NormalizedAttachment = {
  fileName: string;
  mimeType: string;
  size: number;
  download: () => Promise<Buffer>;
};

type NormalizedEmail = {
  messageId: string;
  threadId?: string;
  from: string;
  subject: string;
  receivedAt?: string;
  bodyText: string;
  attachments?: NormalizedAttachment[];
};

/** Opciones de lectura según el propósito del buzón (filtros del Report Scheduler de OPERA). */
type FetchOptions = { purpose: EmailPurpose; fromDomain?: string | null };

// ---- pms_shadow: reglas puras (probadas en __tests__/email-connections.test.mts) ----

/** `configJson.purpose` de la conexión; cualquier valor desconocido o ausente = reservation_ai. */
export function purposeOf(connection: { configJson?: unknown }): EmailPurpose {
  const config = connection.configJson && typeof connection.configJson === "object" && !Array.isArray(connection.configJson) ? (connection.configJson as Record<string, unknown>) : {};
  return config.purpose === "pms_shadow" ? "pms_shadow" : "reservation_ai";
}

function configText(connection: { configJson?: unknown }, key: string): string | null {
  const config = connection.configJson && typeof connection.configJson === "object" && !Array.isArray(connection.configJson) ? (connection.configJson as Record<string, unknown>) : {};
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Extensión csv | txt | xml | xlsx y tamaño ≤ PMS_SHADOW_MAX_FILE_BYTES (5 MiB); tamaño desconocido (0) pasa y se acota al descargar. */
export function isPmsShadowAttachment(attachment: { fileName: string; size: number }): boolean {
  const extension = attachmentExtension(attachment.fileName);
  if (!(PMS_SHADOW_ATTACHMENT_EXTENSIONS as readonly string[]).includes(extension)) return false;
  return attachment.size <= PMS_SHADOW_MAX_FILE_BYTES;
}

/** Filtro de asunto (`configJson.subjectContains`): sin filtro → todo pasa; comparación sin mayúsculas ni espacios sobrantes. */
export function matchesSubjectFilter(subject: string | null | undefined, subjectContains: string | null | undefined): boolean {
  const filter = (subjectContains ?? "").trim().toLowerCase();
  if (!filter) return true;
  return (subject ?? "").toLowerCase().includes(filter);
}

/** Filtro de remitente (`configJson.fromDomain`): sin filtro → todo pasa; casa el dominio (o subdominio) del From. */
export function matchesFromDomain(from: string | null | undefined, fromDomain: string | null | undefined): boolean {
  const domain = (fromDomain ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!domain) return true;
  const address = (from ?? "").toLowerCase();
  const at = address.lastIndexOf("@");
  const host = (at >= 0 ? address.slice(at + 1) : address).replace(/[>\s].*$/, "");
  return host === domain || host.endsWith(`.${domain}`);
}

// ---------------------------------------------------------------------------
// OAuth config (env-gated). Real providers activate when credentials are set.
// ---------------------------------------------------------------------------
function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() && !/your-|changeme|placeholder/i.test(v) ? v.trim() : undefined;
}
function oauthConfig(provider: Provider) {
  if (provider === "gmail") {
    const clientId = env("GMAIL_CLIENT_ID");
    const clientSecret = env("GMAIL_CLIENT_SECRET");
    const redirectUri = env("GMAIL_REDIRECT_URI") ?? `${env("API_PUBLIC_URL") ?? "http://localhost:3000"}/integrations/email/oauth/callback`;
    return clientId && clientSecret ? { clientId, clientSecret, redirectUri } : null;
  }
  if (provider === "microsoft") {
    const clientId = env("MS_CLIENT_ID");
    const clientSecret = env("MS_CLIENT_SECRET");
    const tenant = env("MS_TENANT") ?? "common";
    const redirectUri = env("MS_REDIRECT_URI") ?? `${env("API_PUBLIC_URL") ?? "http://localhost:3000"}/integrations/email/oauth/callback`;
    return clientId && clientSecret ? { clientId, clientSecret, tenant, redirectUri } : null;
  }
  return null;
}
export function emailProvidersStatus() {
  return {
    gmail: { configured: !!oauthConfig("gmail") },
    microsoft: { configured: !!oauthConfig("microsoft") },
    imap: { configured: false, note: "Requiere la dependencia 'imapflow' (no instalada)." },
    manual: { configured: true }
  };
}

export function getAuthorizeUrl(provider: Provider, connectionId: string): string {
  if (provider === "gmail") {
    const c = oauthConfig("gmail");
    if (!c) throw new BadRequestError("Gmail OAuth no está configurado (faltan GMAIL_CLIENT_ID/SECRET).");
    const p = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email",
      state: `gmail:${connectionId}`
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
  }
  if (provider === "microsoft") {
    const c = oauthConfig("microsoft");
    if (!c) throw new BadRequestError("Microsoft OAuth no está configurado (faltan MS_CLIENT_ID/SECRET).");
    const p = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      response_type: "code",
      response_mode: "query",
      scope: "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read",
      state: `microsoft:${connectionId}`
    });
    return `https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/authorize?${p.toString()}`;
  }
  throw new BadRequestError(`El proveedor ${provider} no usa OAuth.`);
}

export async function handleOAuthCallback(state: string, code: string) {
  const [provider, connectionId] = state.split(":") as [Provider, string];
  const connection = await prisma.emailConnection.findUnique({ where: { id: connectionId } });
  if (!connection) throw new BadRequestError("Conexión no encontrada.");
  const c = oauthConfig(provider);
  if (!c) throw new BadRequestError("OAuth no configurado.");

  const tokenUrl = provider === "gmail" ? "https://oauth2.googleapis.com/token" : `https://login.microsoftonline.com/${(c as { tenant: string }).tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: c.redirectUri });
  const res = await fetch(tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new BadRequestError(`Intercambio OAuth falló: ${await res.text().catch(() => res.status)}`);
  const tokens = (await res.json()) as { refresh_token?: string; access_token?: string };
  if (!tokens.refresh_token) throw new BadRequestError("No se recibió refresh_token (revoca el acceso y reintenta con prompt=consent).");

  let emailAddress: string | undefined;
  try {
    if (provider === "gmail" && tokens.access_token) {
      const me = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      emailAddress = (await me.json())?.email;
    } else if (provider === "microsoft" && tokens.access_token) {
      const me = await fetch("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      const j = await me.json();
      emailAddress = j?.mail ?? j?.userPrincipalName;
    }
  } catch (err) {
    // Best-effort: the mailbox works without its display address, but log why
    // it is missing so a connection listed without email is explainable.
    console.warn("[mailbox.oauth] userinfo lookup failed; connection saved without emailAddress", {
      provider,
      connectionId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  await prisma.emailConnection.update({
    where: { id: connectionId },
    data: { oauthRefreshToken: tokens.refresh_token, status: "connected", emailAddress: emailAddress ?? connection.emailAddress, lastError: null }
  });
  return { connectionId, provider, emailAddress };
}

// ---- access-token cache (single-flight) -----------------------------------
const tokenCache = new Map<string, { token: string; exp: number }>();
const inflight = new Map<string, Promise<string>>();
async function getAccessToken(connection: { id: string; provider: string; oauthRefreshToken: string | null }): Promise<string> {
  const cached = tokenCache.get(connection.id);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const existing = inflight.get(connection.id);
  if (existing) return existing;
  const p = (async () => {
    const c = oauthConfig(connection.provider as Provider);
    if (!c || !connection.oauthRefreshToken) throw new BadRequestError("Conexión sin OAuth válido.");
    const tokenUrl = connection.provider === "gmail" ? "https://oauth2.googleapis.com/token" : `https://login.microsoftonline.com/${(c as { tenant: string }).tenant}/oauth2/v2.0/token`;
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: connection.oauthRefreshToken, client_id: c.clientId, client_secret: c.clientSecret });
    const res = await fetch(tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!res.ok) throw new BadRequestError(`Refresh token falló: ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in?: number };
    tokenCache.set(connection.id, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
    return j.access_token;
  })().finally(() => inflight.delete(connection.id));
  inflight.set(connection.id, p);
  return p;
}

// ---- provider fetchers ----------------------------------------------------
function decodeGmailBody(payload: unknown): string {
  const p = payload as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
  if (p?.body?.data) {
    // Best-effort: a malformed base64 body falls through to the MIME parts below.
    try { return Buffer.from(p.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { /* fall through to parts */ }
  }
  if (Array.isArray(p?.parts)) {
    for (const part of p.parts) {
      const sub = decodeGmailBody(part);
      if (sub) return sub;
    }
  }
  return "";
}

/** base64url de Gmail (cuerpos y adjuntos) → bytes; la misma conversión que decodeGmailBody. */
function decodeGmailBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Recorre `payload.parts` recursivamente y recoge las partes con `filename` + `body.attachmentId` (adjuntos reales, no inline vacíos). */
function collectGmailAttachments(payload: unknown, out: Array<{ fileName: string; mimeType: string; size: number; attachmentId: string }> = []): Array<{ fileName: string; mimeType: string; size: number; attachmentId: string }> {
  const p = payload as { filename?: string; mimeType?: string; body?: { attachmentId?: string; size?: number }; parts?: unknown[] } | null | undefined;
  if (!p) return out;
  if (p.filename && p.body?.attachmentId) {
    out.push({ fileName: p.filename, mimeType: p.mimeType ?? "application/octet-stream", size: Number(p.body.size ?? 0), attachmentId: p.body.attachmentId });
  }
  if (Array.isArray(p.parts)) for (const part of p.parts) collectGmailAttachments(part, out);
  return out;
}

async function fetchGmail(connection: { id: string; provider: string; oauthRefreshToken: string | null }, options: FetchOptions = { purpose: "reservation_ai" }): Promise<NormalizedEmail[]> {
  const token = await getAccessToken(connection);
  // pms_shadow: solo correos con adjunto de los últimos 3 días (Report Scheduler diario) y, si hay filtro, del dominio remitente.
  const query = options.purpose === "pms_shadow" ? `has:attachment newer_than:3d${options.fromDomain ? ` from:${options.fromDomain.trim().replace(/^@/, "")}` : ""}` : "newer_than:30d";
  const list = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=" + encodeURIComponent(query), { headers: { Authorization: `Bearer ${token}` } });
  if (!list.ok) throw new BadRequestError(`Gmail list falló: ${list.status}`);
  const ids = ((await list.json())?.messages ?? []) as Array<{ id: string }>;
  const out: NormalizedEmail[] = [];
  for (const { id } of ids.slice(0, 15)) {
    const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
    if (!m.ok) continue;
    const msg = await m.json();
    const headers = (msg?.payload?.headers ?? []) as Array<{ name: string; value: string }>;
    const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    const attachments: NormalizedAttachment[] =
      options.purpose === "pms_shadow"
        ? collectGmailAttachments(msg.payload).map((part) => ({
            fileName: part.fileName,
            mimeType: part.mimeType,
            size: part.size,
            download: async () => {
              const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/attachments/${part.attachmentId}`, { headers: { Authorization: `Bearer ${token}` } });
              if (!res.ok) throw new BadRequestError(`Gmail attachment falló: ${res.status}`);
              const body = (await res.json()) as { data?: string };
              return decodeGmailBase64Url(body.data ?? "");
            }
          }))
        : [];
    out.push({
      messageId: msg.id,
      threadId: msg.threadId,
      from: h("From"),
      subject: h("Subject"),
      receivedAt: new Date(Number(msg.internalDate)).toISOString(),
      // pms_shadow: el cuerpo no se lee (solo importan los adjuntos); nunca se persiste.
      bodyText: options.purpose === "pms_shadow" ? "" : decodeGmailBody(msg.payload) || msg.snippet || "",
      ...(options.purpose === "pms_shadow" ? { attachments } : {})
    });
  }
  return out;
}

async function fetchGraph(connection: { id: string; provider: string; oauthRefreshToken: string | null }, options: FetchOptions = { purpose: "reservation_ai" }): Promise<NormalizedEmail[]> {
  const token = await getAccessToken(connection);
  const filter = options.purpose === "pms_shadow" ? "&$filter=hasAttachments%20eq%20true" : "";
  const url = `https://graph.microsoft.com/v1.0/me/messages?$top=15&$orderby=receivedDateTime%20desc&$select=id,subject,from,receivedDateTime,bodyPreview,body,hasAttachments${filter}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' } });
  if (!res.ok) throw new BadRequestError(`Graph messages falló: ${res.status}`);
  const items = ((await res.json())?.value ?? []) as Array<Record<string, unknown>>;
  const out: NormalizedEmail[] = [];
  for (const m of items) {
    const messageId = String(m.id);
    let attachments: NormalizedAttachment[] | undefined;
    if (options.purpose === "pms_shadow" && m.hasAttachments === true) {
      // Solo metadatos aquí (sin contentBytes); la descarga es perezosa por adjunto.
      const listed = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${messageId}/attachments?$select=id,name,contentType,size`, { headers: { Authorization: `Bearer ${token}` } });
      const rows = listed.ok ? (((await listed.json())?.value ?? []) as Array<Record<string, unknown>>) : [];
      attachments = rows
        .filter((row) => row["@odata.type"] === "#microsoft.graph.fileAttachment")
        .map((row) => ({
          fileName: String(row.name ?? ""),
          mimeType: String(row.contentType ?? "application/octet-stream"),
          size: Number(row.size ?? 0),
          download: async () => {
            const one = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${messageId}/attachments/${String(row.id)}`, { headers: { Authorization: `Bearer ${token}` } });
            if (!one.ok) throw new BadRequestError(`Graph attachment falló: ${one.status}`);
            const body = (await one.json()) as { "@odata.type"?: string; contentBytes?: string };
            if (body["@odata.type"] !== "#microsoft.graph.fileAttachment" || !body.contentBytes) throw new BadRequestError("Adjunto de Graph sin contenido (solo se admiten fileAttachment).");
            return Buffer.from(body.contentBytes, "base64");
          }
        }));
    }
    out.push({
      messageId,
      from: ((m.from as { emailAddress?: { address?: string } })?.emailAddress?.address) ?? "",
      subject: String(m.subject ?? ""),
      receivedAt: String(m.receivedDateTime ?? ""),
      bodyText: options.purpose === "pms_shadow" ? "" : String((m.body as { content?: string })?.content ?? m.bodyPreview ?? ""),
      ...(attachments ? { attachments } : {})
    });
  }
  return out;
}

// ---- heuristics -----------------------------------------------------------
const OTA_DOMAINS: Record<string, string> = {
  "booking.com": "booking_com",
  "expedia.com": "expedia",
  "airbnb.com": "airbnb",
  "hotelbeds.com": "wholesale"
};
function detectSource(email: NormalizedEmail): string {
  const from = email.from.toLowerCase();
  for (const [domain, source] of Object.entries(OTA_DOMAINS)) if (from.includes(domain)) return source;
  return "direct";
}
function looksLikeBooking(email: NormalizedEmail): boolean {
  const from = email.from.toLowerCase();
  if (Object.keys(OTA_DOMAINS).some((d) => from.includes(d))) return true;
  const hay = `${email.subject} ${email.bodyText}`.toLowerCase();
  return /(reserva|booking|reservation|confirmaci[oó]n|confirmation|check[- ]?in|noche?s|estancia|alojamiento)/.test(hay);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
async function processNormalizedEmail(input: { context: UserContext; connection: { id: string; propertyId: string; provider: string }; email: NormalizedEmail; correlationId: string }) {
  const { connection, email } = input;
  const existing = await prisma.inboundEmail.findUnique({ where: { connectionId_messageId: { connectionId: connection.id, messageId: email.messageId } } });
  if (existing && existing.status !== "received" && existing.status !== "error") return existing; // dedup

  const detectedSource = detectSource(email);
  const snippet = email.bodyText.slice(0, 280);
  const base = {
    connectionId: connection.id,
    propertyId: connection.propertyId,
    provider: connection.provider,
    messageId: email.messageId,
    threadId: email.threadId,
    fromAddress: email.from,
    subject: email.subject,
    receivedAt: email.receivedAt ? new Date(email.receivedAt) : null,
    snippet,
    detectedSource
  };

  if (!looksLikeBooking(email)) {
    return prisma.inboundEmail.upsert({
      where: { connectionId_messageId: { connectionId: connection.id, messageId: email.messageId } },
      create: { ...base, status: "ignored" },
      update: { status: "ignored", snippet, detectedSource }
    });
  }

  const parsed = await parseReservationRequest({ context: input.context, propertyId: connection.propertyId, text: email.bodyText });
  const confidencePct = Math.round((parsed.confidence ?? 0) * 100);

  const row = await prisma.inboundEmail.upsert({
    where: { connectionId_messageId: { connectionId: connection.id, messageId: email.messageId } },
    create: { ...base, status: "review", parseSource: parsed.source, confidence: confidencePct, draftJson: parsed.draft as Prisma.InputJsonValue },
    update: { status: "review", parseSource: parsed.source, confidence: confidencePct, draftJson: parsed.draft as Prisma.InputJsonValue, snippet, detectedSource }
  });

  const review = await enqueueReview({
    organizationId: input.context.organizationId,
    propertyId: connection.propertyId,
    reviewType: "email_reservation",
    relatedEntityType: "inbound_email",
    relatedEntityId: row.id,
    payloadJson: { from: email.from, subject: email.subject, source: detectedSource, parseSource: parsed.source, confidence: confidencePct, draft: parsed.draft as Prisma.InputJsonValue },
    correlationId: input.correlationId,
    actorUserId: input.context.userId
  });
  return prisma.inboundEmail.update({ where: { id: row.id }, data: { reviewItemId: review.id } });
}

// ---- pms_shadow: un correo del Report Scheduler → un run por adjunto ----------

export type ShadowEmailOutcome = { status: "shadow_ingested" | "shadow_ignored" | "seen"; ingested: number; failed: number; ignored: number };

/**
 * Propósito `pms_shadow` (Tanda 7b · L3): por mensaje NO visto (InboundEmail
 * @@unique(connectionId, messageId)), filtros `subjectContains` / `fromDomain`, y por
 * adjunto csv | txt | xml | xlsx ≤ 5 MiB → ingestPmsShadowFile (source "email", feed
 * "auto") con el contexto de sistema de la organización de la propiedad. Sin adjunto
 * reconocible → alerta OPERA_FEED_UNRECOGNIZED (nombre de fichero / asunto, sin PII).
 * El HITL (processNormalizedEmail) NO se llama; el cuerpo no se persiste (snippet
 * vacío) y el adjunto se descarga, se procesa y se descarta.
 */
async function processShadowEmail(input: {
  connection: { id: string; propertyId: string; provider: string; configJson: unknown };
  organizationId: string;
  timezone: string;
  scheduleJson: unknown;
  email: NormalizedEmail;
  correlationId: string;
}): Promise<ShadowEmailOutcome> {
  const { connection, email } = input;
  const existing = await prisma.inboundEmail.findUnique({ where: { connectionId_messageId: { connectionId: connection.id, messageId: email.messageId } } });
  if (existing && (existing.status === "shadow_ingested" || existing.status === "shadow_ignored")) return { status: "seen", ingested: 0, failed: 0, ignored: 0 };
  const base = {
    connectionId: connection.id,
    propertyId: connection.propertyId,
    provider: connection.provider,
    messageId: email.messageId,
    threadId: email.threadId,
    fromAddress: email.from,
    subject: email.subject,
    receivedAt: email.receivedAt ? new Date(email.receivedAt) : null,
    snippet: "",
    detectedSource: "opera"
  };
  const persist = async (status: "shadow_ingested" | "shadow_ignored", draft: Record<string, unknown>) =>
    prisma.inboundEmail.upsert({
      where: { connectionId_messageId: { connectionId: connection.id, messageId: email.messageId } },
      create: { ...base, status, parseSource: "none", draftJson: draft as Prisma.InputJsonValue },
      update: { status, parseSource: "none", draftJson: draft as Prisma.InputJsonValue, snippet: "", detectedSource: "opera" }
    });

  const subjectContains = configText(connection, "subjectContains");
  const fromDomain = configText(connection, "fromDomain");
  if (!matchesSubjectFilter(email.subject, subjectContains) || !matchesFromDomain(email.from, fromDomain)) {
    await persist("shadow_ignored", { purpose: "pms_shadow", reason: "filter", subjectContains, fromDomain });
    return { status: "shadow_ignored", ingested: 0, failed: 0, ignored: 1 };
  }
  const candidates = (email.attachments ?? []).filter(isPmsShadowAttachment);
  if (candidates.length === 0) {
    // SEC-07: la alerta no guarda el asunto ni los nombres de adjunto de un correo cualquiera del buzón
    // (pueden llevar nombres de huésped o texto de terceros): solo conteos, extensiones y tamaños.
    const attachmentsSummary = (email.attachments ?? []).map((a) => ({ extension: attachmentExtension(a.fileName) || null, size: a.size }));
    await createAlertIfOpen({
      organizationId: input.organizationId,
      propertyId: connection.propertyId,
      code: "OPERA_FEED_UNRECOGNIZED",
      message: `Correo del buzón OPERA sin adjunto reconocible (csv, txt, xml o xlsx ≤ 5 MB): ${attachmentsSummary.length} adjunto(s) recibido(s). Revisa el mensaje en el buzón.`,
      expected: { extensions: [...PMS_SHADOW_ATTACHMENT_EXTENSIONS], maxBytes: PMS_SHADOW_MAX_FILE_BYTES },
      actual: { attachmentCount: attachmentsSummary.length, attachments: attachmentsSummary, messageId: email.messageId }
    });
    await persist("shadow_ignored", { purpose: "pms_shadow", reason: "no_attachment", attachments: attachmentsSummary });
    return { status: "shadow_ignored", ingested: 0, failed: 0, ignored: 1 };
  }

  const context = systemContext(input.organizationId, connection.propertyId);
  const today = localDateTime(new Date(), input.timezone).date;
  const schedule = scheduleFeedsOf(input.scheduleJson);
  const results: Array<Record<string, unknown>> = [];
  let ingested = 0;
  let failed = 0;
  for (const attachment of candidates) {
    try {
      const bytes = await attachment.download();
      // Business date explícito: en modo sombra el business date de Anfitorio no avanza (el night
      // audit ocurre en OPERA): hoy en la zona del hotel + businessDateOffset del feed programado.
      // Los ingresos no lo llevan: manda la fecha que declara el propio XML.
      const feed = classifyFeed({ fileName: attachment.fileName, head: bytes.subarray(0, 4096).toString("utf8") });
      const offset = feed ? (schedule.find((entry) => entry.feed === feed)?.businessDateOffset ?? 0) : 0;
      const businessDate = feed && feed !== "revenue" ? addDaysIso(today, offset) : null;
      const result = await ingestPmsShadowFile({ context, propertyId: connection.propertyId, source: "email", feed: "auto", fileName: attachment.fileName, bytes, businessDate, correlationId: input.correlationId, createdBy: `email_connection:${connection.id}` });
      results.push({ fileName: attachment.fileName, size: bytes.length, runId: result.runId, status: result.status, counts: result.counts });
      ingested += 1;
    } catch (err) {
      // QC-06: un adjunto que falla (duplicado, perfil en pausa, fichero ilegible) se registra con
      // correlación y no detiene los demás adjuntos ni el sondeo del buzón.
      const typed = err as { statusCode?: unknown; details?: { code?: unknown }; message?: unknown };
      const code = typeof typed.details?.code === "string" ? typed.details.code : null;
      // SEC-08: solo los errores de dominio (4xx con código) persisten su mensaje; un fallo interno (Prisma,
      // red, 5xx) se guarda como texto genérico y el detalle va al log con la correlación.
      const domainError = typeof typed.statusCode === "number" && typed.statusCode < 500 && code !== null;
      results.push({ fileName: attachment.fileName, error: code ?? "ERROR", message: domainError && typeof typed.message === "string" ? typed.message.slice(0, 300) : "Error interno al ingerir el adjunto; revisa el registro del API con el identificador de correlación." });
      failed += 1;
      console.error("[mailbox.poll] pms_shadow attachment failed", { connectionId: connection.id, propertyId: connection.propertyId, correlationId: input.correlationId, fileName: attachment.fileName, code, error: typeof typed.message === "string" ? typed.message : String(err) });
    }
  }
  const status = ingested > 0 ? "shadow_ingested" : "shadow_ignored";
  await persist(status, { purpose: "pms_shadow", attachments: results });
  return { status, ingested, failed, ignored: 0 };
}

export async function pollConnection(input: { context: UserContext; connectionId: string; correlationId: string }) {
  const connection = await prisma.emailConnection.findUnique({ where: { id: input.connectionId } });
  if (!connection) throw new BadRequestError("Conexión no encontrada.");
  if (connection.status !== "connected") throw new BadRequestError("La conexión no está conectada.");
  try {
    const purpose = purposeOf(connection);
    const options: FetchOptions = { purpose, fromDomain: configText(connection, "fromDomain") };
    let messages: NormalizedEmail[] = [];
    if (connection.provider === "gmail") messages = await fetchGmail(connection, options);
    else if (connection.provider === "microsoft") messages = await fetchGraph(connection, options);
    else if (connection.provider === "imap") throw new BadRequestError("IMAP requiere la dependencia 'imapflow' (no instalada). Usa el conector manual o Gmail/Microsoft.");
    else if (connection.provider === "manual") return { processed: 0, note: "El conector manual no se sondea; usa 'ingerir email'." };

    let processed = 0;
    if (purpose === "pms_shadow") {
      // Buzón del hotel para el modo sombra: adjuntos → ingest; organización y programación por la propiedad.
      const property = await prisma.property.findUnique({ where: { id: connection.propertyId }, select: { organizationId: true, timezone: true } });
      if (!property) throw new BadRequestError("La propiedad del buzón no existe.");
      const profile = await findProfile(property.organizationId, connection.propertyId);
      if (!profile) throw new BadRequestError("La propiedad del buzón no tiene perfil de modo sombra OPERA: créalo en Configuración › Integraciones antes de sondear.");
      let ingested = 0;
      let failed = 0;
      let ignored = 0;
      for (const email of messages) {
        const outcome = await processShadowEmail({ connection, organizationId: property.organizationId, timezone: property.timezone, scheduleJson: profile.scheduleJson, email, correlationId: input.correlationId });
        if (outcome.status === "seen") continue;
        processed++;
        ingested += outcome.ingested;
        failed += outcome.failed;
        ignored += outcome.ignored;
      }
      await prisma.emailConnection.update({ where: { id: connection.id }, data: { lastSyncAt: new Date(), lastError: failed > 0 ? `${failed} adjunto(s) no ingerido(s) en el último sondeo (ver el registro de cortes).` : null } });
      return { processed, purpose, ingested, failed, ignored };
    }
    for (const email of messages) {
      await processNormalizedEmail({ context: input.context, connection, email, correlationId: input.correlationId });
      processed++;
    }
    await prisma.emailConnection.update({ where: { id: connection.id }, data: { lastSyncAt: new Date(), lastError: null } });
    return { processed };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error de sondeo.";
    await prisma.emailConnection.update({ where: { id: connection.id }, data: { lastError: message } });
    throw err instanceof BadRequestError ? err : new BadRequestError(message);
  }
}

export async function pollAllConnections(context: UserContext): Promise<{ connections: number; processed: number; failed: string[] }> {
  const connections = await prisma.emailConnection.findMany({ where: { status: "connected", provider: { in: ["gmail", "microsoft"] } } });
  let total = 0;
  const failed: string[] = [];
  for (const c of connections) {
    const correlationId = `corr_mailbox_${c.id}`;
    try {
      const r = await pollConnection({ context, connectionId: c.id, correlationId });
      total += (r as { processed?: number }).processed ?? 0;
    } catch (err) {
      // Keep polling the other mailboxes (one expired token must not stop the
      // whole poller), but never silently: pollConnection already persisted
      // emailConnection.lastError; here we log with correlation and report the
      // connection id back to the scheduler tick, which warns when failed > 0.
      failed.push(c.id);
      console.error("[mailbox.poll] connection failed", {
        connectionId: c.id,
        propertyId: c.propertyId,
        correlationId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return { connections: connections.length, processed: total, failed };
}

// approveReview/rejectReview (human-review.service.ts) throw a plain Error
// "Cannot approve|reject a review item with status …" when the item was already
// decided. That is the ONLY tolerated outcome when closing the review from the
// email flow: the inbound email is still processed. Anything else (DB down,
// missing row) is re-thrown so the review queue never drifts from the email.
function isReviewAlreadyDecided(err: unknown): boolean {
  if (err instanceof ConflictError) return true;
  const message = err instanceof Error ? err.message : "";
  return /Cannot (approve|reject) a review item with status/.test(message);
}

/** Manual/demo ingest: paste an email and run the identical pipeline. */
export async function ingestManualEmail(input: { context: UserContext; propertyId: string; connectionId?: string; from?: string; subject?: string; body: string; correlationId: string }) {
  requirePermissions(input.context, ["integrations.connect"]);
  if (!input.body || !input.body.trim()) throw new BadRequestError("El cuerpo del email es obligatorio.");
  let connection = input.connectionId ? await prisma.emailConnection.findUnique({ where: { id: input.connectionId } }) : null;
  if (!connection) {
    connection = await prisma.emailConnection.findFirst({ where: { propertyId: input.propertyId, provider: "manual" } });
  }
  if (!connection) {
    connection = await prisma.emailConnection.create({ data: { propertyId: input.propertyId, provider: "manual", status: "connected", emailAddress: "manual@demo" } });
  }
  const email: NormalizedEmail = {
    messageId: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: input.from?.trim() || "huesped@example.com",
    subject: input.subject?.trim() || "(sin asunto)",
    receivedAt: new Date().toISOString(),
    bodyText: input.body
  };
  const row = await processNormalizedEmail({ context: input.context, connection: { id: connection.id, propertyId: connection.propertyId, provider: "manual" }, email, correlationId: input.correlationId });
  return row;
}

// ---- CRUD -----------------------------------------------------------------
function mapConnection(c: { id: string; provider: string; status: string; emailAddress: string | null; configJson: unknown; lastSyncAt: Date | null; lastError: string | null }) {
  return { id: c.id, provider: c.provider, status: c.status, emailAddress: c.emailAddress, config: c.configJson, lastSyncAt: c.lastSyncAt?.toISOString() ?? null, lastError: c.lastError };
}
export async function listConnections(propertyId: string) {
  const rows = await prisma.emailConnection.findMany({ where: { propertyId }, orderBy: { createdAt: "desc" } });
  return rows.map(mapConnection);
}
export async function createConnection(input: { context: UserContext; propertyId: string; payload: Record<string, unknown>; correlationId: string }) {
  requirePermissions(input.context, ["integrations.connect"]);
  const provider = String(input.payload.provider) as Provider;
  if (!PROVIDERS.includes(provider)) throw new BadRequestError("Proveedor no válido.");
  const isOAuth = provider === "gmail" || provider === "microsoft";
  // Tanda 7b (L3): propósito y filtros del buzón (para todos los proveedores) además de host/port/username del IMAP.
  const purpose: EmailPurpose = input.payload.purpose === "pms_shadow" ? "pms_shadow" : "reservation_ai";
  const filters = {
    ...(typeof input.payload.fromDomain === "string" && input.payload.fromDomain.trim() ? { fromDomain: input.payload.fromDomain.trim() } : {}),
    ...(typeof input.payload.subjectContains === "string" && input.payload.subjectContains.trim() ? { subjectContains: input.payload.subjectContains.trim() } : {})
  };
  const data: Prisma.EmailConnectionCreateInput = {
    propertyId: input.propertyId,
    provider,
    status: provider === "manual" ? "connected" : provider === "imap" ? "connected" : "pending_auth",
    emailAddress: typeof input.payload.emailAddress === "string" ? input.payload.emailAddress : undefined,
    configJson: ({ ...(provider === "imap" ? { host: input.payload.host, port: input.payload.port ?? 993, username: input.payload.username } : {}), purpose, ...filters }) as Prisma.InputJsonValue,
    imapPassword: provider === "imap" && typeof input.payload.password === "string" ? input.payload.password : undefined
  };
  const row = await prisma.emailConnection.create({ data });
  recordAuditEvent({ organizationId: input.context.organizationId, propertyId: input.propertyId, actorUserId: input.context.userId, actorType: "user", action: "EMAIL_CONNECTION_CREATED", entityType: "email_connection", entityId: row.id, afterJson: { provider, status: row.status, purpose, ...filters }, correlationId: input.correlationId });
  return { ...mapConnection(row), needsOAuth: isOAuth, authorizeAvailable: isOAuth && !!oauthConfig(provider) };
}
/**
 * Pure (Cocoa 22 · ola 11): what «Desconectar» does with a row. A connection that
 * was never authorised (`pending_auth` without a refresh token — the Gmail row an
 * operator added and abandoned) is deleted, so the list does not keep a
 * «Gmail · desconectado» ghost forever; anything that ever held credentials is
 * kept as `disconnected` (audit trail, inbound emails keep their connection).
 */
export function disconnectOutcome(row: { status: string; oauthRefreshToken: string | null | undefined }): "delete" | "disconnect" {
  return row.status === "pending_auth" && !row.oauthRefreshToken ? "delete" : "disconnect";
}

export async function disconnectConnection(input: { context: UserContext; connectionId: string; correlationId: string }) {
  requirePermissions(input.context, ["integrations.disconnect"]);
  const current = await prisma.emailConnection.findUnique({ where: { id: input.connectionId } });
  if (!current) throw new NotFoundError("Conexión de correo no encontrada.");
  tokenCache.delete(input.connectionId);
  if (disconnectOutcome(current) === "delete") {
    await prisma.emailConnection.delete({ where: { id: current.id } });
    recordAuditEvent({ organizationId: input.context.organizationId, propertyId: current.propertyId, actorUserId: input.context.userId, actorType: "user", action: "EMAIL_CONNECTION_DELETED", entityType: "email_connection", entityId: current.id, beforeJson: { provider: current.provider, status: current.status }, afterJson: null, correlationId: input.correlationId });
    return { ...mapConnection({ ...current, status: "deleted" }), deleted: true };
  }
  const row = await prisma.emailConnection.update({ where: { id: input.connectionId }, data: { status: "disconnected", oauthRefreshToken: null, imapPassword: null } });
  recordAuditEvent({ organizationId: input.context.organizationId, propertyId: row.propertyId, actorUserId: input.context.userId, actorType: "user", action: "EMAIL_CONNECTION_DISCONNECTED", entityType: "email_connection", entityId: row.id, afterJson: { status: "disconnected" }, correlationId: input.correlationId });
  return { ...mapConnection(row), deleted: false };
}

export async function listInbound(propertyId: string, status?: string) {
  const where: Prisma.InboundEmailWhereInput = { propertyId };
  if (status) where.status = status;
  const rows = await prisma.inboundEmail.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    from: r.fromAddress,
    subject: r.subject,
    receivedAt: r.receivedAt?.toISOString() ?? null,
    snippet: r.snippet,
    detectedSource: r.detectedSource,
    status: r.status,
    parseSource: r.parseSource,
    confidence: r.confidence ? Number(r.confidence) : null,
    draft: r.draftJson,
    reservationId: r.reservationId
  }));
}

// ---- approve / reject (HITL) ----------------------------------------------
export async function approveEmailReservation(input: { context: UserContext; inboundEmailId: string; overrides?: Record<string, unknown>; correlationId: string }) {
  requirePermissions(input.context, ["pms.reservation.create"]);
  const row = await prisma.inboundEmail.findUnique({ where: { id: input.inboundEmailId } });
  if (!row) throw new BadRequestError("Email no encontrado.");
  if (row.status === "reservation_created") throw new BadRequestError("La reserva ya fue creada para este email.");
  const draft = { ...(row.draftJson as Record<string, unknown>), ...(input.overrides ?? {}) };

  const arrivalDate = String(draft.arrivalDate ?? "");
  const departureDate = String(draft.departureDate ?? "");
  let roomTypeId = draft.roomTypeId ? String(draft.roomTypeId) : "";
  if (!roomTypeId) {
    const rt = await prisma.roomType.findFirst({ where: { propertyId: row.propertyId, active: true, sellable: true }, orderBy: { name: "asc" } });
    roomTypeId = rt?.id ?? "";
  }
  if (!arrivalDate || !departureDate || !roomTypeId) {
    throw new BadRequestError("Faltan datos para crear la reserva (fechas y tipo de habitación). Edítalos y reintenta.");
  }

  // Tanda L3 (lote A): no `totalAmount` on purpose — createReservation quotes
  // the stay from the rate grid (plan of the draft → BAR → lowest published;
  // 0 € with `priceSource none | partial` when nothing is published). The
  // draft's rate plan, when the extractor or the reviewer set one, travels so
  // the quote prices from it.
  const reservation = await createReservation({
    context: input.context,
    propertyId: row.propertyId,
    channel: "email",
    sourceCode: row.detectedSource ?? "email",
    arrivalDate,
    departureDate,
    roomTypeId,
    ratePlanId: draft.ratePlanId ? String(draft.ratePlanId) : undefined,
    adults: typeof draft.adults === "number" ? draft.adults : Number(draft.adults) || 1,
    children: typeof draft.children === "number" ? draft.children : Number(draft.children) || 0,
    boardType: draft.boardType ? String(draft.boardType) : undefined,
    bookerName: draft.guestName ? String(draft.guestName) : undefined,
    bookerEmail: draft.email ? String(draft.email) : undefined,
    specialRequests: draft.specialRequests ? String(draft.specialRequests) : undefined,
    externalReference: row.messageId,
    correlationId: input.correlationId
  });

  if (row.reviewItemId) {
    try {
      await approveReview({ context: input.context, id: row.reviewItemId, userId: input.context.userId, notes: "Reserva creada desde email", correlationId: input.correlationId });
    } catch (err) {
      if (!isReviewAlreadyDecided(err)) throw err;
      console.warn("[email.reservation] review already decided; reservation created anyway", {
        reviewItemId: row.reviewItemId,
        inboundEmailId: row.id,
        correlationId: input.correlationId
      });
    }
  }
  const updated = await prisma.inboundEmail.update({ where: { id: row.id }, data: { status: "reservation_created", reservationId: reservation.id } });
  recordAuditEvent({ organizationId: input.context.organizationId, propertyId: row.propertyId, actorUserId: input.context.userId, actorType: "user", action: "EMAIL_RESERVATION_CREATED", entityType: "reservation", entityId: reservation.id, afterJson: { inboundEmailId: row.id, code: reservation.code }, correlationId: input.correlationId });
  return { reservationId: reservation.id, code: reservation.code, inbound: updated.id };
}

export async function rejectEmailReservation(input: { context: UserContext; inboundEmailId: string; reason?: string; correlationId: string }) {
  requirePermissions(input.context, ["integrations.connect"]);
  const row = await prisma.inboundEmail.findUnique({ where: { id: input.inboundEmailId } });
  if (!row) throw new BadRequestError("Email no encontrado.");
  if (row.reviewItemId) {
    try {
      await rejectReview({ context: input.context, id: row.reviewItemId, userId: input.context.userId, reason: input.reason ?? "Descartado", correlationId: input.correlationId });
    } catch (err) {
      if (!isReviewAlreadyDecided(err)) throw err;
      console.warn("[email.reservation] review already decided; email marked ignored anyway", {
        reviewItemId: row.reviewItemId,
        inboundEmailId: row.id,
        correlationId: input.correlationId
      });
    }
  }
  const updated = await prisma.inboundEmail.update({ where: { id: row.id }, data: { status: "ignored" } });
  return { id: updated.id, status: updated.status };
}
