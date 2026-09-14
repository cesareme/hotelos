// Staff invitations (Tanda 3 · invitaciones / CFG-P1-6).
//
// Before this module three different "user creation" flows existed and none of
// them produced an invitation that could be accepted: the back-office invite
// created a passwordless user and showed a fake "Invitación enviada" toast,
// createTenant returned a temp password in clear plus a link to an in-memory
// token nobody consumed, and POST /users required the admin to type the
// employee's password. This service is the single, honest path:
//
//   createInvitation  → persisted `user_invitations` row (sha256 of a 32-byte
//                       token, 72 h TTL, previous invitations revoked), email
//                       'user_invitation' through the notification dispatcher,
//                       and an honest delivery status (sent | simulated |
//                       failed | disabled). The invitation NEVER fails because
//                       of the email: the row is persisted first and the link
//                       is returned so an operator can hand it over by hand.
//   getInvitationByToken → summary for the public /accept-invite screen; null
//                       (generic 404) for invalid, expired, used or revoked.
//   acceptInvitation  → password policy + scrypt hash, user activated, token
//                       consumed atomically (single use, race-safe), pending
//                       resets/invitations revoked, session opened exactly like
//                       POST /auth/login (same LoginResult).
//   reissueInvitation / revokeInvitations → admin "Reenviar" / "Revocar".
//
// The raw token only ever travels in the invite URL (response + email). It is
// stored hashed, and it is redacted from the persisted notification delivery
// after the send attempt so `notifications.read` holders cannot replay it.

import { createHash, randomBytes } from "node:crypto";
import { prisma, hashPassword, type Prisma } from "@hotelos/database";
import { recordAuditEvent } from "../audit/audit.service.js";
import { ConflictError, HttpError, NotFoundError } from "../../lib/http-error.js";
import { demoStore } from "../../lib/demo-store.js";
import {
  dispatch as defaultDispatch,
  type DispatchInput,
  type NotificationDeliveryRecord
} from "../notifications/dispatcher.service.js";
import { emailStatus as providerEmailStatus, type EmailStatus } from "../notifications/providers/email.provider.js";
import { assertPasswordPolicy, recordSuccessfulLogin } from "./auth-pilot.service.js";
import { createSessionForUser, type LoginResult } from "./auth.service.js";

export const INVITATION_TTL_HOURS = 72;
export const DEFAULT_APP_BASE_URL = "http://localhost:5173";
export const INVITATION_TEMPLATE_CODE = "user_invitation";
export const INVITATION_INVALID_CODE = "INVITATION_INVALID" as const;

/** Placeholder written over the raw token in persisted email bodies. */
export const REDACTED_TOKEN = "[token-oculto]";

// ───────────────────────────────────────────────────────────── public types

export type InvitationDeliveryStatus = "sent" | "simulated" | "failed" | "disabled";

export type InvitationDelivery = {
  /**
   * sent      → a real provider accepted the message.
   * simulated → no provider configured outside production: nothing was sent,
   *             the operator must hand the inviteUrl over by another channel.
   * failed    → the provider (or the dispatcher) rejected the message.
   * disabled  → production without an email provider (EMAIL_PROVIDER/KEY/FROM).
   */
  status: InvitationDeliveryStatus;
  provider?: string;
  errorMessage?: string;
  /** notification_deliveries.id when the dispatcher recorded the attempt. */
  deliveryId?: string;
};

export type InvitationIssueResult = {
  inviteUrl: string;
  expiresAt: string;
  delivery: InvitationDelivery;
};

export type InvitationSummary = {
  email: string;
  fullName: string | null;
  organizationName: string;
  propertyName: string | null;
  roleName: string | null;
  expiresAt: string;
};

export type CreateInvitationInput = {
  userId: string;
  organizationId: string;
  propertyId?: string | null;
  roleId?: string | null;
  actorUserId: string | null;
  correlationId?: string;
  /** Internal: marks the audit event as a re-send (reissueInvitation). */
  reissue?: boolean;
};

/** Injection points so the flow is unit-testable without a live provider. */
export type InvitationDeps = {
  dispatchFn?: (input: DispatchInput) => Promise<NotificationDeliveryRecord>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
};

// ───────────────────────────────────────────────────────────── pure helpers

/** 32 random bytes, base64url (43 chars, URL-safe, 256 bits of entropy). */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Only the sha256 of the token is persisted (a DB dump cannot replay invites). */
export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** APP_BASE_URL without trailing slash; defaults to the local admin-web dev server. */
export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.APP_BASE_URL?.trim();
  return (raw || DEFAULT_APP_BASE_URL).replace(/\/+$/, "");
}

export function buildInviteUrl(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${appBaseUrl(env)}/accept-invite?token=${encodeURIComponent(token)}`;
}

export function buildPasswordResetUrl(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${appBaseUrl(env)}/reset-password?token=${encodeURIComponent(token)}`;
}

export function invitationExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITATION_TTL_HOURS * 60 * 60 * 1000);
}

export type InvitationLifecycleRow = { expiresAt: Date; usedAt: Date | null; revokedAt: Date | null };
export type InvitationState = "valid" | "used" | "revoked" | "expired";

/** Lifecycle of a persisted invitation. Anything but "valid" is a generic 404 to the public. */
export function invitationState(row: InvitationLifecycleRow, now: Date = new Date()): InvitationState {
  if (row.usedAt) return "used";
  if (row.revokedAt) return "revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "valid";
}

/**
 * Map a dispatcher outcome (or a dispatcher exception) to the honest delivery
 * status the front shows. `failure` is the exception message when dispatch
 * threw (template_not_found, unknown channel, DB error); `delivery` is the
 * persisted row otherwise.
 */
export function classifyDelivery(
  delivery: NotificationDeliveryRecord | null,
  failure: string | null,
  email: EmailStatus
): InvitationDelivery {
  const provider = email.provider ?? undefined;
  if (failure !== null || !delivery) {
    return {
      status: email.mode === "disabled" ? "disabled" : "failed",
      provider,
      errorMessage: failure ?? "El envío no se registró.",
      deliveryId: delivery?.id
    };
  }
  if (delivery.status === "sent") {
    const simulated = email.mode !== "real" || (delivery.errorMessage ?? "").startsWith("SIMULADO");
    return simulated
      ? { status: "simulated", provider, errorMessage: delivery.errorMessage ?? undefined, deliveryId: delivery.id }
      : { status: "sent", provider, deliveryId: delivery.id };
  }
  return {
    status: email.mode === "disabled" ? "disabled" : "failed",
    provider,
    errorMessage: delivery.errorMessage ?? "El proveedor no confirmó el envío.",
    deliveryId: delivery.id
  };
}

/** Same shape the contract (G) exposes on GET /notifications/email-status. */
export function emailStatus(env: NodeJS.ProcessEnv = process.env): EmailStatus {
  return providerEmailStatus(env);
}

/** Generic, non-enumerating 404 for any invalid/expired/used/revoked token. */
function invalidInvitationError(): HttpError {
  return new HttpError(404, "Invitación no válida, caducada o ya utilizada.", true, { code: INVITATION_INVALID_CODE });
}

// ───────────────────────────────────────────────────────────── DB helpers

type InvitableUser = NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>>;

async function requireInvitableUser(userId: string, organizationId: string): Promise<InvitableUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  // Opaque 404 for cross-org ids (same contract as the tenancy hook).
  if (!user || user.organizationId !== organizationId) {
    throw new NotFoundError("Usuario no encontrado.");
  }
  if (user.status === "disabled") {
    throw new ConflictError("No se puede invitar a un usuario deshabilitado; reactívalo primero.");
  }
  return user;
}

async function assertScopeBelongsToOrganization(input: {
  organizationId: string;
  propertyId?: string | null;
  roleId?: string | null;
}): Promise<void> {
  if (input.propertyId) {
    const property = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { organizationId: true } });
    if (!property || property.organizationId !== input.organizationId) {
      throw new NotFoundError("Propiedad no encontrada.");
    }
  }
  if (input.roleId) {
    const role = await prisma.role.findUnique({ where: { id: input.roleId }, select: { organizationId: true } });
    if (!role || role.organizationId !== input.organizationId) {
      throw new NotFoundError("Rol no encontrado.");
    }
  }
}

/**
 * Overwrite the raw secret (invite/reset token) in the persisted delivery so
 * `notifications.read` holders cannot lift a live token from the deliveries
 * screen. "Reenviar invitación" issues a fresh token, so the dispatcher's
 * retry of the redacted body is not a supported path for these two templates.
 * Best-effort with an explicit error log: the invitation itself is already
 * persisted and returned.
 */
export async function redactSecretInDelivery(delivery: NotificationDeliveryRecord | null, secret: string): Promise<void> {
  if (!delivery || !secret) return;
  const body = delivery.bodyRendered ?? "";
  const encoded = encodeURIComponent(secret);
  const payload = (delivery.payloadJson ?? null) as { variables?: Record<string, unknown> } | null;
  const variables = payload?.variables ?? {};
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variables)) {
    scrubbed[key] =
      typeof value === "string" && (value.includes(secret) || value.includes(encoded))
        ? value.replaceAll(encoded, REDACTED_TOKEN).replaceAll(secret, REDACTED_TOKEN)
        : value;
  }
  try {
    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        bodyRendered: body.replaceAll(encoded, REDACTED_TOKEN).replaceAll(secret, REDACTED_TOKEN),
        payloadJson: { ...(payload ?? {}), variables: scrubbed, redacted: true } as Prisma.InputJsonValue
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[invitations] could not redact the token from delivery ${delivery.id}: ${message}`);
  }
}

// ───────────────────────────────────────────────────────────── createInvitation

export async function createInvitation(
  input: CreateInvitationInput,
  deps: InvitationDeps = {}
): Promise<InvitationIssueResult> {
  const dispatchFn = deps.dispatchFn ?? defaultDispatch;
  const env = deps.env ?? process.env;
  const now = deps.now ? deps.now() : new Date();

  const user = await requireInvitableUser(input.userId, input.organizationId);
  await assertScopeBelongsToOrganization(input);

  const token = generateInvitationToken();
  const expiresAt = invitationExpiresAt(now);

  const invitation = await prisma.$transaction(async (tx) => {
    // One live invitation per user: older links stop working immediately.
    await tx.userInvitation.updateMany({
      where: { userId: user.id, usedAt: null, revokedAt: null },
      data: { revokedAt: now }
    });
    return tx.userInvitation.create({
      data: {
        userId: user.id,
        organizationId: input.organizationId,
        propertyId: input.propertyId ?? null,
        roleId: input.roleId ?? null,
        tokenHash: hashInvitationToken(token),
        expiresAt,
        createdByUserId: input.actorUserId ?? null
      }
    });
  });

  const inviteUrl = buildInviteUrl(token, env);
  const delivery = await deliverInvitationEmail({
    invitation,
    user,
    inviteUrl,
    token,
    actorUserId: input.actorUserId,
    dispatchFn,
    env
  });

  await prisma.userInvitation.update({
    where: { id: invitation.id },
    data: { deliveryId: delivery.deliveryId ?? null, deliveryStatus: delivery.status }
  });

  recordAuditEvent({
    organizationId: input.organizationId,
    propertyId: input.propertyId ?? undefined,
    actorUserId: input.actorUserId ?? undefined,
    actorType: input.actorUserId ? "user" : "system",
    action: "USER_INVITED",
    entityType: "user",
    entityId: user.id,
    afterJson: {
      invitationId: invitation.id,
      email: user.email,
      propertyId: input.propertyId ?? null,
      roleId: input.roleId ?? null,
      expiresAt: expiresAt.toISOString(),
      reissue: input.reissue === true,
      delivery: { status: delivery.status, provider: delivery.provider ?? null, errorMessage: delivery.errorMessage ?? null }
    },
    correlationId: input.correlationId ?? "user_invite"
  });

  return { inviteUrl, expiresAt: expiresAt.toISOString(), delivery };
}

async function deliverInvitationEmail(input: {
  invitation: { id: string; organizationId: string; propertyId: string | null };
  user: { email: string; fullName: string };
  inviteUrl: string;
  token: string;
  actorUserId: string | null;
  dispatchFn: NonNullable<InvitationDeps["dispatchFn"]>;
  env: NodeJS.ProcessEnv;
}): Promise<InvitationDelivery> {
  const status = providerEmailStatus(input.env);
  const [organization, property, inviter] = await Promise.all([
    prisma.organization.findUnique({ where: { id: input.invitation.organizationId }, select: { name: true } }),
    input.invitation.propertyId
      ? prisma.property.findUnique({ where: { id: input.invitation.propertyId }, select: { name: true } })
      : Promise.resolve(null),
    input.actorUserId
      ? prisma.user.findUnique({ where: { id: input.actorUserId }, select: { fullName: true } })
      : Promise.resolve(null)
  ]);

  const variables: Record<string, unknown> = {
    inviteUrl: input.inviteUrl,
    inviterName: inviter?.fullName ?? "",
    inviteeName: input.user.fullName,
    organizationName: organization?.name ?? "",
    propertyName: property?.name ?? "",
    propertyNameSuffix: property ? ` (${property.name})` : "",
    expiryHours: INVITATION_TTL_HOURS
  };

  let delivery: NotificationDeliveryRecord | null = null;
  let failure: string | null = null;
  try {
    delivery = await input.dispatchFn({
      organizationId: input.invitation.organizationId,
      propertyId: input.invitation.propertyId ?? undefined,
      templateCode: INVITATION_TEMPLATE_CODE,
      channel: "email",
      recipient: input.user.email,
      notificationId: `invite:${input.invitation.id}`,
      language: "es",
      variables
    });
  } catch (error) {
    // Honest catch (QC-06): the invitation row is already persisted; the email
    // is best-effort, its failure is logged here AND surfaced to the caller in
    // delivery.status/errorMessage so the operator can hand the link over.
    failure = error instanceof Error ? error.message : String(error);
    console.error(`[invitations] email delivery failed for invitation ${input.invitation.id}: ${failure}`);
  }
  await redactSecretInDelivery(delivery, input.token);
  return classifyDelivery(delivery, failure, status);
}

// ───────────────────────────────────────────────────────────── getInvitationByToken

export async function getInvitationByToken(token: string, now: Date = new Date()): Promise<InvitationSummary | null> {
  const raw = (token ?? "").trim();
  if (raw.length < 20) return null;
  const row = await prisma.userInvitation.findUnique({ where: { tokenHash: hashInvitationToken(raw) } });
  if (!row || invitationState(row, now) !== "valid") return null;

  const user = await prisma.user.findUnique({
    where: { id: row.userId },
    select: { email: true, fullName: true, status: true, organizationId: true }
  });
  if (!user || user.status === "disabled" || user.organizationId !== row.organizationId) return null;

  const [organization, property, role] = await Promise.all([
    prisma.organization.findUnique({ where: { id: row.organizationId }, select: { name: true } }),
    row.propertyId ? prisma.property.findUnique({ where: { id: row.propertyId }, select: { name: true } }) : Promise.resolve(null),
    row.roleId ? prisma.role.findUnique({ where: { id: row.roleId }, select: { name: true } }) : Promise.resolve(null)
  ]);
  if (!organization) return null;

  return {
    email: user.email,
    fullName: user.fullName || null,
    organizationName: organization.name,
    propertyName: property?.name ?? null,
    roleName: role?.name ?? null,
    expiresAt: row.expiresAt.toISOString()
  };
}

// ───────────────────────────────────────────────────────────── acceptInvitation

export async function acceptInvitation(input: {
  token: string;
  password: string;
  deviceId?: string;
}): Promise<LoginResult> {
  // Policy first (same order as resetPassword): a weak password is a 400 the
  // form can fix; an invalid token is a generic 404 that reveals nothing.
  assertPasswordPolicy(input.password);

  const now = new Date();
  const raw = (input.token ?? "").trim();
  if (raw.length < 20) throw invalidInvitationError();
  const row = await prisma.userInvitation.findUnique({ where: { tokenHash: hashInvitationToken(raw) } });
  if (!row || invitationState(row, now) !== "valid") throw invalidInvitationError();

  const passwordHash = hashPassword(input.password);

  const user = await prisma.$transaction(async (tx) => {
    // Single use, race-safe: the conditional update succeeds for exactly one
    // caller; a concurrent second accept sees count 0 and gets the generic 404.
    const consumed = await tx.userInvitation.updateMany({
      where: { id: row.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now }
    });
    if (consumed.count !== 1) throw invalidInvitationError();

    const current = await tx.user.findUnique({ where: { id: row.userId } });
    if (!current || current.organizationId !== row.organizationId || current.status === "disabled") {
      throw invalidInvitationError();
    }

    const updated = await tx.user.update({
      where: { id: current.id },
      data: {
        passwordHash,
        passwordChangedAt: now,
        status: "active",
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: null
      }
    });

    // The role promised in the invitation becomes a real grant (idempotent):
    // without a user_property_roles row the invitee would get 403 everywhere
    // in production (AUTH-07 pattern).
    if (row.propertyId && row.roleId) {
      await tx.userPropertyRole.upsert({
        where: { userId_propertyId_roleId: { userId: current.id, propertyId: row.propertyId, roleId: row.roleId } },
        update: {},
        create: { userId: current.id, propertyId: row.propertyId, roleId: row.roleId }
      });
    }

    // Any other pending link for this account dies with the acceptance.
    await tx.userInvitation.updateMany({
      where: { userId: current.id, id: { not: row.id }, usedAt: null, revokedAt: null },
      data: { revokedAt: now }
    });
    await tx.passwordResetToken.updateMany({
      where: { userId: current.id, usedAt: null },
      data: { usedAt: now }
    });
    await tx.session.updateMany({
      where: { userId: current.id, status: "active" },
      data: { status: "revoked", revokedAt: now }
    });
    return updated;
  });

  // Keep the in-memory mirror (back-office user list) honest in the demo.
  const mirror = demoStore.users.find((candidate) => candidate.id === user.id);
  if (mirror) {
    mirror.status = "active";
    mirror.mustChangePassword = false;
  }

  recordAuditEvent({
    organizationId: user.organizationId,
    propertyId: row.propertyId ?? undefined,
    actorUserId: user.id,
    actorType: "user",
    action: "USER_INVITATION_ACCEPTED",
    entityType: "user",
    entityId: user.id,
    afterJson: { invitationId: row.id, propertyId: row.propertyId, roleId: row.roleId },
    correlationId: "user_invite"
  });

  // Accepting is the first successful sign-in: same bookkeeping as /auth/login.
  await recordSuccessfulLogin(user.id);
  return createSessionForUser({
    user,
    deviceId: input.deviceId?.trim() || "unknown_device",
    auditAction: "AUTH_LOGIN"
  });
}

// ───────────────────────────────────────────────────────────── reissue / revoke

export async function reissueInvitation(
  input: { userId: string; organizationId: string; actorUserId: string | null },
  deps: InvitationDeps = {}
): Promise<InvitationIssueResult> {
  const user = await requireInvitableUser(input.userId, input.organizationId);

  // Carry over the scope of the last invitation; fall back to the first real
  // assignment so an accepted-then-reissued user keeps their role.
  const previous = await prisma.userInvitation.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { propertyId: true, roleId: true }
  });
  let propertyId = previous?.propertyId ?? null;
  let roleId = previous?.roleId ?? null;
  if (!propertyId || !roleId) {
    const assignment = await prisma.userPropertyRole.findFirst({
      where: { userId: user.id },
      orderBy: { id: "asc" },
      select: { propertyId: true, roleId: true }
    });
    if (assignment) {
      propertyId = assignment.propertyId;
      roleId = assignment.roleId;
    }
  }

  return createInvitation(
    {
      userId: user.id,
      organizationId: input.organizationId,
      propertyId,
      roleId,
      actorUserId: input.actorUserId,
      correlationId: "user_invite_reissue",
      reissue: true
    },
    deps
  );
}

/** Revoke every pending invitation of a user (disable / delete flows). Returns the count. */
export async function revokeInvitations(userId: string, now: Date = new Date()): Promise<number> {
  const result = await prisma.userInvitation.updateMany({
    where: { userId, usedAt: null, revokedAt: null },
    data: { revokedAt: now }
  });
  return result.count;
}

export type PendingInvitationInfo = {
  invitationId: string;
  expiresAt: string;
  expired: boolean;
  deliveryStatus: string | null;
  createdAt: string;
};

/**
 * Latest pending (unused, unrevoked) invitation per user, for user lists that
 * show "Invitado · caduca DD/MM" and the Reenviar/Copiar enlace actions.
 * Expired rows are included with `expired: true` so the UI can offer a resend.
 */
export async function getPendingInvitations(userIds: string[]): Promise<Map<string, PendingInvitationInfo>> {
  const result = new Map<string, PendingInvitationInfo>();
  if (userIds.length === 0) return result;
  const rows = await prisma.userInvitation.findMany({
    where: { userId: { in: userIds }, usedAt: null, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, userId: true, expiresAt: true, deliveryStatus: true, createdAt: true }
  });
  const now = Date.now();
  for (const row of rows) {
    if (result.has(row.userId)) continue;
    result.set(row.userId, {
      invitationId: row.id,
      expiresAt: row.expiresAt.toISOString(),
      expired: row.expiresAt.getTime() <= now,
      deliveryStatus: row.deliveryStatus,
      createdAt: row.createdAt.toISOString()
    });
  }
  return result;
}
