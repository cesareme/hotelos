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
//
// Tanda 8a · L3 (RBAC por departamento, design §5.5, §6.5): an invitation is
// plantilla × ámbito. `roleId` is mandatory (an invitee without a role holds
// zero permissions), the row carries `scopeType` / `scopeRef` (property by
// default: the property of the invitation) and `invitedByUserId`, it expires
// after at most INVITATION_MAX_DAYS, templates of level N2+ (ROLE_LEVEL_RANK
// ≥ 2) mark the user for 2FA enrolment (`mfaEnabled`, decision D8) and an
// invitee without a credential yet is flagged `mustChangePassword` until it
// sets one on accept. On acceptance the grant is written in BOTH tables
// (`writeRoleAssignment`: user_property_roles for scope property + the
// user_role_assignments row of the real scope) in the same transaction, and
// audited as ROLE_ASSIGNED once it committed.

import { createHash, randomBytes } from "node:crypto";
import { prisma, hashPassword, type Prisma } from "@hotelos/database";
import { INVITATION_MAX_DAYS, ROLE_LEVEL_RANK, ROLE_TEMPLATE_KEYS, ROLE_TEMPLATE_LEVEL, type RoleKey, type ScopeType } from "@hotelos/shared";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError, ConflictError, HttpError, NotFoundError } from "../../lib/http-error.js";
import { demoStore } from "../../lib/demo-store.js";
import {
  dispatch as defaultDispatch,
  type DispatchInput,
  type NotificationDeliveryRecord
} from "../notifications/dispatcher.service.js";
import { emailStatus as providerEmailStatus, type EmailStatus } from "../notifications/providers/email.provider.js";
import { assertPasswordPolicy, recordRoleAssigned, recordSuccessfulLogin, writeRoleAssignment, type RoleAssignmentWritten } from "./auth-pilot.service.js";
import { createSessionForUser, type LoginResult } from "./auth.service.js";

export const INVITATION_TTL_HOURS = 72;
/** Hard ceiling of an invitation's life (design §5.5: ≤ 7 days), whatever TTL a caller asks for. */
export const INVITATION_MAX_TTL_HOURS = INVITATION_MAX_DAYS * 24;
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
  /** Tanda 8a: scope of the assignment the acceptance creates (property when the row predates the column). */
  scopeType: ScopeType | null;
};

export type CreateInvitationInput = {
  userId: string;
  organizationId: string;
  propertyId?: string | null;
  /** Mandatory since Tanda 8a (400 without it): the role the acceptance grants. */
  roleId?: string | null;
  /**
   * Tanda 8a (§5.5): scope of the assignment the acceptance creates. Defaults
   * to `property` / `propertyId`; `scopeRef` is the id of the property, the
   * property group or the legal entity (the organisation id for `organization`).
   */
  scopeType?: ScopeType | null;
  scopeRef?: string | null;
  /** Who invited (audit + grantedByUserId of the assignment); defaults to actorUserId. */
  invitedByUserId?: string | null;
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

/**
 * Expiry of an invitation issued at `now`: INVITATION_TTL_HOURS by default,
 * never more than INVITATION_MAX_TTL_HOURS (design §5.5: ≤ 7 days) whatever a
 * caller asks for; a non-positive or non-finite TTL falls back to the default.
 */
export function invitationExpiresAt(now: Date = new Date(), ttlHours: number = INVITATION_TTL_HOURS): Date {
  const requested = Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : INVITATION_TTL_HOURS;
  const hours = Math.min(requested, INVITATION_MAX_TTL_HOURS);
  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

/** ROLE_LEVEL_RANK of a template (1 for a custom role): templates ≥ 2 (N2+) require 2FA enrolment (D8). */
export function invitationRequiresMfa(templateKey: string | null | undefined): boolean {
  if (!templateKey || !(ROLE_TEMPLATE_KEYS as readonly string[]).includes(templateKey)) return false;
  return ROLE_LEVEL_RANK[ROLE_TEMPLATE_LEVEL[templateKey as RoleKey]] >= 2;
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

type ResolvedInvitationScope = {
  role: { id: string; name: string; templateKey: string | null };
  scopeType: ScopeType;
  /** Property / group / legal entity / organisation id the assignment will point at. */
  scopeRef: string;
  /** Property the email and the audit trail mention (the scope for `property`; the optional home property otherwise). */
  propertyId: string | null;
};

/**
 * Tanda 8a: the role is mandatory, must belong to the organisation and never
 * be the emergency template (opaque 404); the scope defaults to the property
 * of the invitation and its ref must belong to the organisation (opaque 404
 * for a foreign or unknown ref: same contract as the tenancy hook).
 */
async function resolveInvitationScope(input: {
  organizationId: string;
  propertyId?: string | null;
  roleId?: string | null;
  scopeType?: ScopeType | null;
  scopeRef?: string | null;
}): Promise<ResolvedInvitationScope> {
  if (!input.roleId) {
    throw new BadRequestError("El rol es obligatorio: sin rol la persona invitada no tendría permisos.");
  }
  const role = await prisma.role.findUnique({ where: { id: input.roleId }, select: { id: true, name: true, organizationId: true, templateKey: true } });
  if (!role || role.organizationId !== input.organizationId || role.templateKey === "break_glass") {
    throw new NotFoundError("Rol no encontrado.");
  }
  const scopeType: ScopeType | null = input.scopeType ?? (input.propertyId ? "property" : null);
  if (!scopeType) {
    throw new BadRequestError("La invitación necesita un ámbito: propiedad, grupo de propiedades, sociedad u organización.");
  }
  let propertyId: string | null = null;
  if (input.propertyId) {
    const property = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { organizationId: true } });
    if (!property || property.organizationId !== input.organizationId) {
      throw new NotFoundError("Propiedad no encontrada.");
    }
    propertyId = input.propertyId;
  }
  let scopeRef: string;
  switch (scopeType) {
    case "property": {
      const ref = input.scopeRef ?? propertyId;
      if (!ref) throw new BadRequestError("El ámbito property exige la propiedad.");
      if (propertyId && ref !== propertyId) throw new BadRequestError("La propiedad de la invitación y la del ámbito no coinciden.");
      if (!propertyId) {
        const property = await prisma.property.findUnique({ where: { id: ref }, select: { organizationId: true } });
        if (!property || property.organizationId !== input.organizationId) throw new NotFoundError("Propiedad no encontrada.");
        propertyId = ref;
      }
      scopeRef = ref;
      break;
    }
    case "property_group": {
      if (!input.scopeRef) throw new BadRequestError("El ámbito property_group exige el grupo de propiedades.");
      const group = await prisma.propertyGroup.findFirst({ where: { id: input.scopeRef, organizationId: input.organizationId }, select: { id: true } });
      if (!group) throw new NotFoundError("Grupo de propiedades no encontrado.");
      scopeRef = group.id;
      break;
    }
    case "legal_entity": {
      if (!input.scopeRef) throw new BadRequestError("El ámbito legal_entity exige la sociedad.");
      const entity = await prisma.legalEntity.findFirst({ where: { id: input.scopeRef, organizationId: input.organizationId }, select: { id: true } });
      if (!entity) throw new NotFoundError("Sociedad no encontrada.");
      scopeRef = entity.id;
      break;
    }
    case "organization":
      scopeRef = input.organizationId;
      break;
    default:
      throw new BadRequestError("Ámbito no válido.");
  }
  return { role: { id: role.id, name: role.name, templateKey: role.templateKey }, scopeType, scopeRef, propertyId };
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
  const scope = await resolveInvitationScope(input);
  const invitedByUserId = input.invitedByUserId ?? input.actorUserId ?? null;
  const mfaRequired = invitationRequiresMfa(scope.role.templateKey);

  const token = generateInvitationToken();
  const expiresAt = invitationExpiresAt(now);

  const invitation = await prisma.$transaction(async (tx) => {
    // One live invitation per user: older links stop working immediately.
    await tx.userInvitation.updateMany({
      where: { userId: user.id, usedAt: null, revokedAt: null },
      data: { revokedAt: now }
    });
    // Tanda 8a (D8): an invitee still without a credential must set one on
    // accept (cleared there); a template of level N2+ enrols the user in 2FA.
    const flags = {
      ...(user.passwordHash === null ? { mustChangePassword: true } : {}),
      ...(mfaRequired && !user.mfaEnabled ? { mfaEnabled: true } : {})
    };
    if (Object.keys(flags).length > 0) {
      await tx.user.update({ where: { id: user.id }, data: flags });
    }
    return tx.userInvitation.create({
      data: {
        userId: user.id,
        organizationId: input.organizationId,
        propertyId: scope.propertyId,
        roleId: scope.role.id,
        scopeType: scope.scopeType,
        scopeRef: scope.scopeRef,
        invitedByUserId,
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
    expiresAt,
    now,
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
    propertyId: scope.propertyId ?? undefined,
    actorUserId: input.actorUserId ?? undefined,
    actorType: input.actorUserId ? "user" : "system",
    action: "USER_INVITED",
    entityType: "user",
    entityId: user.id,
    afterJson: {
      invitationId: invitation.id,
      email: user.email,
      propertyId: scope.propertyId,
      roleId: scope.role.id,
      templateKey: scope.role.templateKey,
      scopeType: scope.scopeType,
      scopeRef: scope.scopeRef,
      invitedByUserId,
      mfaRequired,
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
  expiresAt: Date;
  now: Date;
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
    // The real life of THIS link (the default TTL, or less when a caller shortened it).
    expiryHours: Math.max(1, Math.round((input.expiresAt.getTime() - input.now.getTime()) / 3_600_000))
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
    expiresAt: row.expiresAt.toISOString(),
    scopeType: row.scopeType ?? (row.propertyId ? "property" : null)
  };
}

// ───────────────────────────────────────────────────────────── acceptInvitation

/**
 * Collaborators of acceptInvitation, injectable so the flow is unit-testable
 * against a fake Prisma (invitations.test.mts): the client (must expose
 * `$transaction`), the clock, the session opener, the login bookkeeping and
 * the audit writer. Production callers pass nothing.
 */
export type AcceptInvitationDeps = {
  db?: typeof prisma;
  now?: () => Date;
  openSession?: typeof createSessionForUser;
  recordLogin?: typeof recordSuccessfulLogin;
  audit?: typeof recordAuditEvent;
};

/** Scope of the grant an invitation row promises (rows that predate Tanda 8a carry only propertyId). */
export function invitationGrantScope(row: { propertyId: string | null; roleId: string | null; scopeType?: ScopeType | null; scopeRef?: string | null }): { roleId: string; scopeType: ScopeType; scopeRef: string } | null {
  if (!row.roleId) return null;
  const scopeType = row.scopeType ?? (row.propertyId ? "property" : null);
  if (!scopeType) return null;
  const scopeRef = row.scopeRef ?? (scopeType === "property" ? row.propertyId : null);
  if (!scopeRef && scopeType !== "organization") return null;
  return { roleId: row.roleId, scopeType, scopeRef: scopeRef ?? "" };
}

export async function acceptInvitation(
  input: {
    token: string;
    password: string;
    deviceId?: string;
  },
  deps: AcceptInvitationDeps = {}
): Promise<LoginResult> {
  const db = deps.db ?? prisma;
  const audit = deps.audit ?? recordAuditEvent;
  // Policy first (same order as resetPassword): a weak password is a 400 the
  // form can fix; an invalid token is a generic 404 that reveals nothing.
  assertPasswordPolicy(input.password);

  const now = deps.now ? deps.now() : new Date();
  const raw = (input.token ?? "").trim();
  if (raw.length < 20) throw invalidInvitationError();
  const row = await db.userInvitation.findUnique({ where: { tokenHash: hashInvitationToken(raw) } });
  if (!row || invitationState(row, now) !== "valid") throw invalidInvitationError();

  const passwordHash = hashPassword(input.password);
  const grant = invitationGrantScope(row);

  const { user, assignment } = await db.$transaction(async (tx) => {
    // Single use, race-safe: the conditional update succeeds for exactly one
    // caller; a concurrent second accept sees count 0 and gets the generic 404.
    const consumed = await tx.userInvitation.updateMany({
      where: { id: row.id, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now }
    });
    if (consumed.count !== 1) throw invalidInvitationError();

    const current = await tx.user.findUnique({ where: { id: row.userId } });
    if (!current || current.organizationId !== row.organizationId || current.status === "disabled" || current.status === "emergency") {
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

    // The role promised in the invitation becomes a real grant in BOTH tables
    // (Tanda 8a dual-write, idempotent on the live tuple): without it the
    // invitee would get 403 everywhere in production (AUTH-07 pattern). A
    // role that disappeared or was retyped since the invite (opaque 404 of
    // the writer) invalidates the link instead of activating a roleless user.
    let written: RoleAssignmentWritten | null = null;
    if (grant) {
      try {
        written = await writeRoleAssignment(tx, {
          userId: current.id,
          organizationId: row.organizationId,
          roleId: grant.roleId,
          scopeType: grant.scopeType,
          scopeRef: grant.scopeType === "organization" ? row.organizationId : grant.scopeRef,
          grantedByUserId: row.invitedByUserId ?? row.createdByUserId ?? null,
          reason: "invitación aceptada",
          now
        });
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 404) throw invalidInvitationError();
        throw error;
      }
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
    return { user: updated, assignment: written };
  });

  // Keep the in-memory mirror (back-office user list) honest in the demo.
  const mirror = demoStore.users.find((candidate) => candidate.id === user.id);
  if (mirror) {
    mirror.status = "active";
    mirror.mustChangePassword = false;
  }

  audit({
    organizationId: user.organizationId,
    propertyId: row.propertyId ?? undefined,
    actorUserId: user.id,
    actorType: "user",
    action: "USER_INVITATION_ACCEPTED",
    entityType: "user",
    entityId: user.id,
    afterJson: {
      invitationId: row.id,
      propertyId: row.propertyId,
      roleId: row.roleId,
      scopeType: grant?.scopeType ?? null,
      scopeRef: grant ? (grant.scopeType === "organization" ? row.organizationId : grant.scopeRef) : null,
      assignmentId: assignment?.assignmentId ?? null
    },
    correlationId: "user_invite"
  });
  // The grant was decided by the inviter (actor), never by the invitee: a
  // system event when the inviter is unknown (rows that predate Tanda 8a).
  if (assignment) {
    if (deps.audit) {
      // Injected trail (tests): mirror recordRoleAssigned without the global writer.
      if (assignment.created) {
        audit({
          organizationId: assignment.organizationId,
          propertyId: assignment.propertyId ?? undefined,
          actorUserId: row.invitedByUserId ?? row.createdByUserId ?? undefined,
          actorType: row.invitedByUserId ?? row.createdByUserId ? "user" : "system",
          action: "ROLE_ASSIGNED",
          entityType: "user_role_assignment",
          entityId: assignment.assignmentId,
          afterJson: { userId: assignment.userId, roleId: assignment.roleId, templateKey: assignment.templateKey, scopeType: assignment.scopeType, ref: assignment.ref, propertyId: assignment.propertyId, reason: assignment.reason, acceptedByUserId: user.id, invitationId: row.id },
          correlationId: "user_invite"
        });
      }
    } else {
      recordRoleAssigned(assignment, {
        actorUserId: row.invitedByUserId ?? row.createdByUserId ?? null,
        correlationId: "user_invite",
        deviceId: input.deviceId?.trim() || undefined,
        extra: { acceptedByUserId: user.id, invitationId: row.id }
      });
    }
  }

  // Accepting is the first successful sign-in: same bookkeeping as /auth/login.
  await (deps.recordLogin ?? recordSuccessfulLogin)(user.id);
  return (deps.openSession ?? createSessionForUser)({
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

  // Carry over the scope of the last invitation; fall back to the first live
  // assignment (new table first, then the legacy per-property row) so an
  // accepted-then-reissued user keeps their role and scope.
  const previous = await prisma.userInvitation.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { propertyId: true, roleId: true, scopeType: true, scopeRef: true }
  });
  let propertyId = previous?.propertyId ?? null;
  let roleId = previous?.roleId ?? null;
  let scopeType: ScopeType | null = previous?.scopeType ?? null;
  let scopeRef: string | null = previous?.scopeRef ?? null;
  if (!roleId || (!scopeType && !propertyId)) {
    const live = await prisma.userRoleAssignment.findFirst({
      where: { userId: user.id, organizationId: input.organizationId, revokedAt: null, OR: [{ validTo: null }, { validTo: { gt: new Date() } }] },
      orderBy: { createdAt: "asc" },
      select: { roleId: true, scopeType: true, propertyId: true, propertyGroupId: true, legalEntityId: true }
    });
    if (live) {
      roleId = live.roleId;
      scopeType = live.scopeType;
      scopeRef = live.propertyId ?? live.propertyGroupId ?? live.legalEntityId ?? input.organizationId;
      propertyId = live.propertyId ?? propertyId;
    } else {
      const legacy = await prisma.userPropertyRole.findFirst({
        where: { userId: user.id },
        orderBy: { id: "asc" },
        select: { propertyId: true, roleId: true }
      });
      if (legacy) {
        propertyId = legacy.propertyId;
        roleId = legacy.roleId;
        scopeType = "property";
        scopeRef = legacy.propertyId;
      }
    }
  }

  return createInvitation(
    {
      userId: user.id,
      organizationId: input.organizationId,
      propertyId,
      roleId,
      scopeType,
      scopeRef,
      invitedByUserId: input.actorUserId,
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
