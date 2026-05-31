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
import { BadRequestError } from "../../../lib/http-error.js";
import { parseReservationRequest } from "../../pms/reservation-agent.service.js";
import { createReservation } from "../../pms/pms.service.js";
import { enqueueReview, approveReview, rejectReview } from "../../ai-operations/human-review.service.js";

const PROVIDERS = ["gmail", "microsoft", "imap", "manual"] as const;
type Provider = (typeof PROVIDERS)[number];

type NormalizedEmail = {
  messageId: string;
  threadId?: string;
  from: string;
  subject: string;
  receivedAt?: string;
  bodyText: string;
};

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
  } catch {
    /* email address is best-effort */
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
    try { return Buffer.from(p.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { /* ignore */ }
  }
  if (Array.isArray(p?.parts)) {
    for (const part of p.parts) {
      const sub = decodeGmailBody(part);
      if (sub) return sub;
    }
  }
  return "";
}

async function fetchGmail(connection: { id: string; provider: string; oauthRefreshToken: string | null }): Promise<NormalizedEmail[]> {
  const token = await getAccessToken(connection);
  const list = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=15&q=" + encodeURIComponent("newer_than:30d"), { headers: { Authorization: `Bearer ${token}` } });
  if (!list.ok) throw new BadRequestError(`Gmail list falló: ${list.status}`);
  const ids = ((await list.json())?.messages ?? []) as Array<{ id: string }>;
  const out: NormalizedEmail[] = [];
  for (const { id } of ids.slice(0, 15)) {
    const m = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
    if (!m.ok) continue;
    const msg = await m.json();
    const headers = (msg?.payload?.headers ?? []) as Array<{ name: string; value: string }>;
    const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    out.push({ messageId: msg.id, threadId: msg.threadId, from: h("From"), subject: h("Subject"), receivedAt: new Date(Number(msg.internalDate)).toISOString(), bodyText: decodeGmailBody(msg.payload) || msg.snippet || "" });
  }
  return out;
}

async function fetchGraph(connection: { id: string; provider: string; oauthRefreshToken: string | null }): Promise<NormalizedEmail[]> {
  const token = await getAccessToken(connection);
  const url = "https://graph.microsoft.com/v1.0/me/messages?$top=15&$orderby=receivedDateTime%20desc&$select=id,subject,from,receivedDateTime,bodyPreview,body";
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' } });
  if (!res.ok) throw new BadRequestError(`Graph messages falló: ${res.status}`);
  const items = ((await res.json())?.value ?? []) as Array<Record<string, unknown>>;
  return items.map((m) => ({
    messageId: String(m.id),
    from: ((m.from as { emailAddress?: { address?: string } })?.emailAddress?.address) ?? "",
    subject: String(m.subject ?? ""),
    receivedAt: String(m.receivedDateTime ?? ""),
    bodyText: String((m.body as { content?: string })?.content ?? m.bodyPreview ?? "")
  }));
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

export async function pollConnection(input: { context: UserContext; connectionId: string; correlationId: string }) {
  const connection = await prisma.emailConnection.findUnique({ where: { id: input.connectionId } });
  if (!connection) throw new BadRequestError("Conexión no encontrada.");
  if (connection.status !== "connected") throw new BadRequestError("La conexión no está conectada.");
  try {
    let messages: NormalizedEmail[] = [];
    if (connection.provider === "gmail") messages = await fetchGmail(connection);
    else if (connection.provider === "microsoft") messages = await fetchGraph(connection);
    else if (connection.provider === "imap") throw new BadRequestError("IMAP requiere la dependencia 'imapflow' (no instalada). Usa el conector manual o Gmail/Microsoft.");
    else if (connection.provider === "manual") return { processed: 0, note: "El conector manual no se sondea; usa 'ingerir email'." };

    let processed = 0;
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

export async function pollAllConnections(context: UserContext) {
  const connections = await prisma.emailConnection.findMany({ where: { status: "connected", provider: { in: ["gmail", "microsoft"] } } });
  let total = 0;
  for (const c of connections) {
    try {
      const r = await pollConnection({ context, connectionId: c.id, correlationId: `corr_mailbox_${c.id}` });
      total += (r as { processed?: number }).processed ?? 0;
    } catch {
      /* keep going */
    }
  }
  return { connections: connections.length, processed: total };
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
  const data: Prisma.EmailConnectionCreateInput = {
    propertyId: input.propertyId,
    provider,
    status: provider === "manual" ? "connected" : provider === "imap" ? "connected" : "pending_auth",
    emailAddress: typeof input.payload.emailAddress === "string" ? input.payload.emailAddress : undefined,
    configJson: (provider === "imap" ? { host: input.payload.host, port: input.payload.port ?? 993, username: input.payload.username } : {}) as Prisma.InputJsonValue,
    imapPassword: provider === "imap" && typeof input.payload.password === "string" ? input.payload.password : undefined
  };
  const row = await prisma.emailConnection.create({ data });
  recordAuditEvent({ organizationId: input.context.organizationId, propertyId: input.propertyId, actorUserId: input.context.userId, actorType: "user", action: "EMAIL_CONNECTION_CREATED", entityType: "email_connection", entityId: row.id, afterJson: { provider, status: row.status }, correlationId: input.correlationId });
  return { ...mapConnection(row), needsOAuth: isOAuth, authorizeAvailable: isOAuth && !!oauthConfig(provider) };
}
export async function disconnectConnection(input: { context: UserContext; connectionId: string; correlationId: string }) {
  requirePermissions(input.context, ["integrations.disconnect"]);
  const row = await prisma.emailConnection.update({ where: { id: input.connectionId }, data: { status: "disconnected", oauthRefreshToken: null, imapPassword: null } });
  tokenCache.delete(input.connectionId);
  recordAuditEvent({ organizationId: input.context.organizationId, propertyId: row.propertyId, actorUserId: input.context.userId, actorType: "user", action: "EMAIL_CONNECTION_DISCONNECTED", entityType: "email_connection", entityId: row.id, afterJson: { status: "disconnected" }, correlationId: input.correlationId });
  return mapConnection(row);
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

  const reservation = await createReservation({
    context: input.context,
    propertyId: row.propertyId,
    channel: "email",
    sourceCode: row.detectedSource ?? "email",
    arrivalDate,
    departureDate,
    roomTypeId,
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
    } catch {
      /* review may already be decided */
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
    } catch {
      /* ignore */
    }
  }
  const updated = await prisma.inboundEmail.update({ where: { id: row.id }, data: { status: "ignored" } });
  return { id: updated.id, status: updated.status };
}
