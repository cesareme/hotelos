// Guest portal authentication (Sprint 40).
//
// The guest portal is NOT staff-authenticated. Guests prove ownership of a
// reservation by knowing its human-readable code (e.g. RES-2026-00042) AND an
// email that matches either the reservation's booker email or a linked guest's
// email. On success we mint a short-lived opaque session token and persist a
// `GuestPortalSession` row.
//
// Security properties:
//   - Anti-enumeration: `requestSignIn` returns `{ ok: false }` for both an
//     unknown code and a known code with the wrong email. We never tell the
//     caller which half was wrong, so the endpoint can't be used to probe for
//     valid reservation codes or guest emails.
//   - Token at rest: only a SHA-256 hash of the token is stored
//     (`GuestPortalSession.tokenHash`). The raw token is returned to the caller
//     once and never persisted, so a DB leak does not yield usable tokens.
//   - Expiry: sessions expire 24h after creation. `verifyGuestToken` rejects
//     expired or non-active sessions.
//
// Production note: in production the raw token would be emailed to the guest as
// a magic link rather than returned in the HTTP response. We emit a
// `GuestPortalSignInRequested` domain event carrying the recipient + token so
// the notification engine (Sprint 26) can pick it up and send the email. For
// now the route also returns the token directly so the portal can be demoed
// without a working mail pipeline — see the `magicLinkDelivered: false` flag.

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@hotelos/database";
import { GUEST_PORTAL_FULL_PURPOSES, GUEST_SESSION_PURPOSES, type GuestSessionPurpose } from "@hotelos/shared";
import { recordDomainEvent } from "../audit/audit.service.js";
import { createId } from "../../lib/ids.js";
import { isEmailConfigured } from "../notifications/providers/email.provider.js";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type RequestSignInInput = {
  reservationCode: string;
  email: string;
  propertyId: string;
};

export type RequestSignInResult =
  | { ok: true; token?: string; reservationId: string; magicLinkDelivered: boolean }
  | { ok: false };

export type VerifiedGuestSession = {
  reservationId: string;
  propertyId: string;
  guestId: string | null;
  /** Ámbito de la sesión (corrector L7-REV-01): sign_in | invitation | survey. */
  purpose: GuestSessionPurpose;
};

/**
 * Corrector L7-REV-01: ámbitos que abren el portal completo (estancia, folio,
 * facturas, peticiones, check-in, chat). Una sesión `survey` (enlace de 30 días
 * de la encuesta post-estancia) SOLO vale para GET|POST /guest-portal/survey:
 * `verifyGuestToken` la rechaza salvo que el llamador la admita explícitamente.
 */
export const GUEST_PORTAL_FULL_ACCESS: readonly GuestSessionPurpose[] = GUEST_PORTAL_FULL_PURPOSES;
/** Todos los ámbitos (solo las rutas de la encuesta los admiten). */
export const GUEST_PORTAL_ANY_PURPOSE: readonly GuestSessionPurpose[] = GUEST_SESSION_PURPOSES;

/** `GuestPortalSession.purpose` leído de la fila: un valor desconocido se trata como sesión completa heredada (`sign_in`). */
export function guestSessionPurposeOf(value: string | null | undefined): GuestSessionPurpose {
  return (GUEST_SESSION_PURPOSES as readonly string[]).includes(value ?? "") ? (value as GuestSessionPurpose) : "sign_in";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Find the reservation a guest is trying to access, but ONLY if the supplied
 * email matches the reservation's booker email or a linked guest's email.
 * Returns the reservation + the matched guest id (if the match was via a
 * linked guest rather than the booker). Returns null when nothing matches —
 * the caller must NOT distinguish "no such code" from "wrong email".
 *
 * `propertyId` is REQUIRED to scope the lookup. `Reservation.code` is unique
 * only per property (`@@unique([propertyId, code])`), so the same code can
 * exist across tenants — querying by code alone leaked sessions cross-tenant.
 */
async function findReservationForGuest(
  reservationCode: string,
  email: string,
  propertyId: string
): Promise<{ reservationId: string; propertyId: string; guestId: string | null } | null> {
  const code = reservationCode.trim();
  const normalizedEmail = normalizeEmail(email);
  const property = propertyId.trim();
  if (!code || !normalizedEmail || !property) return null;

  // Scope by (propertyId, code) — the composite unique on Reservation.
  const reservation = await prisma.reservation.findUnique({
    where: { propertyId_code: { propertyId: property, code } }
  });
  if (!reservation) return null;

  // 1) Booker email is stored in plaintext on the reservation.
  if (reservation.bookerEmail && normalizeEmail(reservation.bookerEmail) === normalizedEmail) {
    const primary = await prisma.reservationGuest.findFirst({
      where: { reservationId: reservation.id, isPrimary: true }
    });
    return {
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      guestId: primary?.guestId ?? null
    };
  }

  // 2) A linked guest's email. Guest.email is encrypted at rest, but the
  // Prisma extension rewrites this equality lookup to the deterministic
  // emailLookupHash sibling column, so the match works on ciphertext rows.
  const links = await prisma.reservationGuest.findMany({
    where: { reservationId: reservation.id },
    select: { guestId: true }
  });
  if (links.length === 0) return null;
  const guest = await prisma.guest.findFirst({
    where: {
      id: { in: links.map((l) => l.guestId) },
      email: normalizedEmail
    },
    select: { id: true }
  });
  if (guest) {
    return {
      reservationId: reservation.id,
      propertyId: reservation.propertyId,
      guestId: guest.id
    };
  }

  return null;
}

export async function requestSignIn(input: RequestSignInInput): Promise<RequestSignInResult> {
  const match = await findReservationForGuest(input.reservationCode, input.email, input.propertyId);
  if (!match) {
    // Anti-enumeration: identical response shape for unknown code and wrong
    // email. Callers cannot tell which input was incorrect.
    return { ok: false };
  }

  const token = randomBytes(32).toString("hex");
  await prisma.guestPortalSession.create({
    data: {
      propertyId: match.propertyId,
      reservationId: match.reservationId,
      guestId: match.guestId,
      tokenHash: hashToken(token),
      status: "active",
      purpose: "sign_in",
      expiresAt: new Date(Date.now() + SESSION_TTL_MS)
    }
  });

  // Emit a domain event so the notification engine can deliver the magic link
  // by email (Sprint 45 wires the `guest_magic_link` template + handler). We
  // resolve organizationId + property name best-effort for the event envelope
  // and the email template variables.
  const property = await prisma.property.findUnique({
    where: { id: match.propertyId },
    select: { organizationId: true, name: true }
  });

  const recipientEmail = normalizeEmail(input.email);
  const reservationCode = input.reservationCode.trim();

  recordDomainEvent({
    organizationId: property?.organizationId ?? match.propertyId,
    propertyId: match.propertyId,
    entityType: "guest_portal_session",
    entityId: match.reservationId,
    eventType: "GuestPortalSignInRequested",
    payload: {
      reservationId: match.reservationId,
      propertyId: match.propertyId,
      // Carries everything the notification handler needs to build + send the
      // magic-link email without re-querying the database.
      recipientEmail,
      // Retained for backward compatibility with pre-Sprint-45 consumers.
      email: recipientEmail,
      reservationCode,
      propertyName: property?.name ?? "",
      // The notification handler builds the magic link from this token.
      token
    },
    // ActorType has no "guest" member; guest-originated events are recorded as
    // "system" since no staff user is acting.
    actorType: "system",
    correlationId: createId("corr")
  });

  // Honesty: the magic link is only really delivered if an email provider is
  // configured (the event hook hands off to the notification dispatcher, which
  // performs the actual send). Without a provider we DON'T claim delivery.
  const magicLinkDelivered = recipientEmail.length > 0 && isEmailConfigured();

  // Return the raw token in the API response when it was NOT delivered by email
  // (so the portal still works without a mail pipeline) or in non-production.
  // In production WITH a configured provider, suppress it unless explicitly
  // enabled via GUEST_PORTAL_RETURN_TOKEN=true.
  const returnToken =
    process.env.GUEST_PORTAL_RETURN_TOKEN === "true" ||
    !magicLinkDelivered ||
    process.env.NODE_ENV !== "production";

  return {
    ok: true,
    reservationId: match.reservationId,
    magicLinkDelivered,
    ...(returnToken ? { token } : {})
  };
}

// ---------------------------------------------------------------------------
// Tanda L7 · lote L7-04 (recon §19.7): sesión del portal emitida por el sistema
// (invitación a la encuesta post-estancia). Misma forma que requestSignIn (token
// aleatorio de 32 bytes, solo el hash en la fila, `guestId` = titular de la
// reserva) pero sin sign-in del huésped: el token viaja en el enlace del correo
// y el remitente lo redacta al persistir la entrega (dispatcher `redact`).
// ---------------------------------------------------------------------------

/** 30 días: vigencia del enlace de la encuesta post-estancia (REPUTACION-REVIEWS §6.4). */
export const POST_STAY_SURVEY_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type IssuedGuestPortalSession = {
  sessionId: string;
  /** Token en claro: solo para el enlace; nunca se persiste ni se audita. */
  token: string;
  reservationId: string;
  propertyId: string;
  guestId: string | null;
  expiresAt: Date;
  purpose: GuestSessionPurpose;
};

/**
 * Emite una GuestPortalSession activa para la reserva (titular = ReservationGuest
 * isPrimary, o el primer enlazado). `ttlMs` acota la vigencia (por defecto la de
 * un sign-in, 24 h); `purpose` fija el ámbito (corrector L7-REV-01: la encuesta
 * emite `survey`, que solo abre las rutas de la encuesta). null si la reserva no
 * existe o está borrada: el llamador decide (el paso del tick lo cuenta como
 * fallo, la ruta manual como 404).
 */
export async function issueGuestPortalSession(input: { reservationId: string; ttlMs?: number; now?: Date; purpose?: GuestSessionPurpose }): Promise<IssuedGuestPortalSession | null> {
  const reservation = await prisma.reservation.findFirst({ where: { id: input.reservationId, deletedAt: null }, select: { id: true, propertyId: true } });
  if (!reservation) return null;
  const link =
    (await prisma.reservationGuest.findFirst({ where: { reservationId: reservation.id, isPrimary: true }, select: { guestId: true } })) ??
    (await prisma.reservationGuest.findFirst({ where: { reservationId: reservation.id }, orderBy: { id: "asc" }, select: { guestId: true } }));
  const now = input.now ?? new Date();
  const ttl = typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs) && input.ttlMs > 0 ? input.ttlMs : SESSION_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl);
  const token = randomBytes(32).toString("hex");
  const session = await prisma.guestPortalSession.create({
    data: {
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      guestId: link?.guestId ?? null,
      tokenHash: hashToken(token),
      status: "active",
      purpose: input.purpose ?? "sign_in",
      expiresAt
    },
    select: { id: true, purpose: true }
  });
  return { sessionId: session.id, token, reservationId: reservation.id, propertyId: reservation.propertyId, guestId: link?.guestId ?? null, expiresAt, purpose: guestSessionPurposeOf(session.purpose) };
}

/**
 * Verifica el token opaco. `options.purposes` (por defecto GUEST_PORTAL_FULL_ACCESS:
 * sign_in + invitation) acota los ámbitos admitidos: una sesión `survey` presentada
 * a cualquier ruta que no sea la encuesta devuelve null (→ 401 GUEST_SESSION_INVALID),
 * igual que un token caducado o revocado. Corrector L7-REV-01.
 */
export async function verifyGuestToken(token: string | null | undefined, options: { purposes?: readonly GuestSessionPurpose[] } = {}): Promise<VerifiedGuestSession | null> {
  if (!token || typeof token !== "string" || token.trim() === "") return null;
  const session = await prisma.guestPortalSession.findFirst({
    where: { tokenHash: hashToken(token.trim()), status: "active" }
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    // Expire lazily on read so stale sessions don't accumulate as "active".
    await prisma.guestPortalSession.update({
      where: { id: session.id },
      data: { status: "expired" }
    });
    return null;
  }
  const purpose = guestSessionPurposeOf(session.purpose);
  if (!(options.purposes ?? GUEST_PORTAL_FULL_ACCESS).includes(purpose)) return null;
  return {
    reservationId: session.reservationId ?? "",
    propertyId: session.propertyId,
    guestId: session.guestId ?? null,
    purpose
  };
}

export async function signOut(token: string | null | undefined): Promise<{ ok: true }> {
  if (token && typeof token === "string" && token.trim() !== "") {
    await prisma.guestPortalSession.updateMany({
      where: { tokenHash: hashToken(token.trim()), status: "active" },
      data: { status: "revoked" }
    });
  }
  // Always report success — signing out an unknown/expired token is a no-op
  // and must not leak whether the token existed.
  return { ok: true };
}
