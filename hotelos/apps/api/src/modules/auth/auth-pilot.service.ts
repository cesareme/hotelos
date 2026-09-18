// PILOT-D1 · Endurecimiento de autenticación para piloto real.
//
// Añade sobre el módulo auth original:
//   1. createUser({...})         · onboarding de cuentas reales (Tanda 3: sin
//                                  contraseña → usuario 'invited' + invitación)
//   2. validatePasswordPolicy()  · min 8, mayúsculas, número, especial
//   3. lockout                   · 5 fallos consecutivos → 15min bloqueo
//   4. password reset flow       · token TTL 15min + hashing + email
//                                  'password_reset' (Tanda 3)
//   5. recordSuccessfulLogin     · resetea contador, actualiza lastLoginAt
//
// El flujo de login original llama a estas funciones (modificación mínima
// en loginWithEmailPassword) para que cualquier intento pase por el lockout.
//
// invitations.service.ts is imported dynamically (it imports assertPasswordPolicy
// from here): keeps the module graph acyclic, same pattern auth.service uses.
//
// Tanda 8a · L3 (RBAC por departamento, docs/design/RBAC-DEPARTAMENTOS.md §6.5,
// §9): this module also hosts `writeRoleAssignment`, the ONE dual-write
// primitive the seven legacy writers of `user_property_roles` share
// (createUser here, acceptInvitation, inviteBackOfficeUser, createTenant,
// property provisioning, the pilot bootstrap; the demo seed writes the same
// shape by hand). Until the cut of L6 both tables are written in the same
// transaction: the legacy row (scope property only) keeps the dual-read of
// lib/rbac-scope.ts honest and the `user_role_assignments` row carries the real
// scope. It lives here because every writer already reaches this module
// without creating an import cycle (invitations → auth-pilot; backoffice,
// tenant-admin and bootstrap → auth-pilot / invitations).

import { createHash, randomBytes } from "node:crypto";
import { prisma, hashPassword } from "@hotelos/database";
import { ROLE_TEMPLATE_KEYS, isPlatformPermission, type RoleKey, type ScopeType } from "@hotelos/shared";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "../../lib/http-error.js";
import { ensureRoleHasPermissions, type RbacDb } from "../../lib/rbac-catalog.js";
import { bumpRbacVersion } from "../../lib/rbac-scope.js";
import type { UserContext } from "../../lib/demo-store.js";
import { dispatch, type NotificationDeliveryRecord } from "../notifications/dispatcher.service.js";
import { emailStatus } from "../notifications/providers/email.provider.js";
import { hasPlatformAdminGrant, isPlatformAdmin, loadPermissionsForUserProperty } from "./auth.service.js";
import type { InvitationDelivery, InvitationIssueResult } from "./invitations.service.js";

const PASSWORD_MIN_LENGTH = 8;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const RESET_TOKEN_TTL_MINUTES = 15;

// ============================================================ password policy

export type PasswordPolicyError = {
  field: "password";
  rule: "min_length" | "uppercase" | "digit" | "special" | "common";
  message: string;
};

const COMMON_PASSWORDS = new Set([
  "12345678", "password", "qwerty12", "abc12345", "111111111",
  "iloveyou", "admin1234", "welcome1", "letmein1"
]);

export function validatePasswordPolicy(plain: string): PasswordPolicyError[] {
  const errors: PasswordPolicyError[] = [];
  if (!plain || plain.length < PASSWORD_MIN_LENGTH) {
    errors.push({ field: "password", rule: "min_length", message: `Mínimo ${PASSWORD_MIN_LENGTH} caracteres.` });
  }
  if (!/[A-Z]/.test(plain)) {
    errors.push({ field: "password", rule: "uppercase", message: "Debe contener al menos una mayúscula." });
  }
  if (!/[0-9]/.test(plain)) {
    errors.push({ field: "password", rule: "digit", message: "Debe contener al menos un número." });
  }
  if (!/[^A-Za-z0-9]/.test(plain)) {
    errors.push({ field: "password", rule: "special", message: "Debe contener al menos un carácter especial." });
  }
  if (COMMON_PASSWORDS.has(plain.toLowerCase())) {
    errors.push({ field: "password", rule: "common", message: "Esta contraseña es demasiado común." });
  }
  return errors;
}

export function assertPasswordPolicy(plain: string): void {
  const errors = validatePasswordPolicy(plain);
  if (errors.length > 0) {
    const msg = errors.map((e) => e.message).join(" ");
    throw new BadRequestError(`Contraseña no válida: ${msg}`);
  }
}

// ============================================================ create user

export type CreateUserInput = {
  organizationId: string;
  email: string;
  /**
   * Optional since Tanda 3: without it the account is created as 'invited'
   * (no password hash) and an invitation email/link is issued so the employee
   * picks their own password. With it (bootstrap/scripts) the account is
   * active immediately, as before.
   */
  password?: string;
  fullName: string;
  phone?: string;
  // Asignación inicial a una property con un rol existente.
  propertyId?: string;
  roleId?: string;
  // Información de auditoría: quién está creando este usuario.
  createdByUserId?: string;
  // Contexto del actor (request.userContext). Preferible a createdByUserId:
  // trae la org ya re-apuntada por el hook de tenencia para platform admins y
  // evita las consultas de resolveActorScope. Opcional hasta que la ruta lo pase.
  actorContext?: UserContext;
};

type ActorScope = { organizationId: string; isPlatformAdmin: boolean };

/**
 * Organization + platform-admin flag of whoever is creating the user, from the
 * request context when available or from the DB row of createdByUserId.
 * `null` only when no actor at all was provided (system flows).
 */
async function resolveActorScope(input: CreateUserInput): Promise<ActorScope | null> {
  if (input.actorContext) {
    return {
      organizationId: input.actorContext.organizationId,
      isPlatformAdmin: await isPlatformAdmin(input.actorContext)
    };
  }
  if (!input.createdByUserId) return null;
  const actor = await prisma.user.findUnique({
    where: { id: input.createdByUserId },
    select: { id: true, organizationId: true }
  });
  if (!actor) {
    throw new ForbiddenError("El usuario que crea la cuenta no existe.");
  }
  // Platform admin = REAL grant of a platform key on any of the actor's
  // property assignments (same rule as auth.service.hasPlatformAdminGrant).
  const assignments = await prisma.userPropertyRole.findMany({
    where: { userId: actor.id },
    select: { propertyId: true },
    distinct: ["propertyId"]
  });
  let platformAdmin = false;
  for (const assignment of assignments) {
    if (hasPlatformAdminGrant(await loadPermissionsForUserProperty(actor.id, assignment.propertyId))) {
      platformAdmin = true;
      break;
    }
  }
  return { organizationId: actor.organizationId, isPlatformAdmin: platformAdmin };
}

/**
 * Tenancy guard for POST /users (audit AUTH inventory): organizationId, roleId
 * and propertyId come from the body, so before Tanda 1 any users.invite holder
 * could create users in another organization or hand out a role of another
 * org (or a role carrying admin.tenants.manage → platform admin escalation).
 * Opaque 404 for cross-org role/property (same contract as the tenancy hook),
 * 403 for org mismatch and for platform-scoped roles.
 */
async function assertCreateUserTenancy(input: CreateUserInput): Promise<void> {
  const scope = await resolveActorScope(input);
  if (scope && !scope.isPlatformAdmin && scope.organizationId !== input.organizationId) {
    throw new ForbiddenError("No puedes crear usuarios en otra organización.");
  }

  if ((input.propertyId && !input.roleId) || (!input.propertyId && input.roleId)) {
    throw new BadRequestError("propertyId y roleId deben indicarse juntos.");
  }
  if (!input.propertyId || !input.roleId) return;

  const [property, role] = await Promise.all([
    prisma.property.findUnique({ where: { id: input.propertyId }, select: { organizationId: true } }),
    prisma.role.findUnique({ where: { id: input.roleId }, select: { id: true, organizationId: true } })
  ]);
  if (!property || property.organizationId !== input.organizationId) {
    throw new NotFoundError("Propiedad no encontrada.");
  }
  if (!role || role.organizationId !== input.organizationId) {
    throw new NotFoundError("Rol no encontrado.");
  }

  if (!scope?.isPlatformAdmin) {
    const grants = await prisma.rolePermission.findMany({ where: { roleId: role.id }, select: { permissionId: true } });
    if (grants.length > 0) {
      const permissions = await prisma.permission.findMany({
        where: { id: { in: grants.map((grant) => grant.permissionId) } },
        select: { key: true }
      });
      if (permissions.some((permission) => isPlatformPermission(permission.key))) {
        throw new ForbiddenError("Solo un administrador de plataforma puede asignar este rol.");
      }
    }
  }

  // Tanda 4 (contract B): never hand out an EMPTY role. A role with 0 grants
  // gets its template applied here (templateKey or name-resolved); a custom
  // role with no template answers 409 ROLE_WITHOUT_PERMISSIONS — the new user
  // would be 403 on every route in production (no demo permission union).
  await ensureRoleHasPermissions(role.id);
}

export type CreateUserResult = {
  id: string;
  email: string;
  fullName: string;
  status: "active" | "invited";
  /** Present when no password was supplied: link + honest delivery status. */
  invitation?: InvitationIssueResult;
  /** Tanda 8a: id of the user_role_assignments row created (or reused) for the initial role. */
  assignmentId?: string;
};

// ============================================================ dual-write de asignaciones (Tanda 8a · L3)

export type RoleAssignmentWriteInput = {
  userId: string;
  organizationId: string;
  roleId: string;
  scopeType: ScopeType;
  /** Id of the property / property group / legal entity the assignment points at; ignored for scope `organization`. */
  scopeRef?: string | null;
  /** Who granted it (null = system: bootstrap, seeds, backfill). */
  grantedByUserId?: string | null;
  reason?: string | null;
  validTo?: Date | null;
  now?: Date;
};

export type RoleAssignmentWritten = {
  /** user_role_assignments.id — the live tuple found, or the row created. */
  assignmentId: string;
  /** true when the user_role_assignments row was created in this call (false = the live tuple already existed: idempotent). */
  created: boolean;
  /** true when the legacy user_property_roles row was created in this call (scope property only). */
  legacyCreated: boolean;
  userId: string;
  organizationId: string;
  roleId: string;
  roleName: string;
  templateKey: RoleKey | null;
  scopeType: ScopeType;
  /** Property / group / legal entity / organisation id the assignment points at. */
  ref: string;
  propertyId: string | null;
  reason: string | null;
};

function knownTemplateKey(value: string | null | undefined): RoleKey | null {
  if (!value) return null;
  return (ROLE_TEMPLATE_KEYS as readonly string[]).includes(value) ? (value as RoleKey) : null;
}

/**
 * Write ONE role assignment in both tables (Tanda 8a · L3, design §6.5 / §9:
 * dual-write until the cut of L6), inside the caller's transaction:
 *   · the role must belong to the organisation and never be the emergency
 *     template (`break_glass` is only ever held by the break-glass accounts of
 *     modules/rbac; every writer here answers an opaque 404);
 *   · the scope ref must belong to the organisation (property / property
 *     group / legal entity; `organization` points at the organisation itself);
 *   · the user must belong to the organisation and not be an emergency account;
 *   · scope `property` also upserts the legacy `user_property_roles` row the
 *     dual-read of lib/rbac-scope.ts still unions (idempotent on its unique);
 *   · `user_role_assignments` is idempotent on the LIVE tuple (revokedAt null
 *     and not expired): the existing row is returned, never duplicated — the
 *     unique index treats NULL scope columns as distinct, so the service, not
 *     the index, enforces it (same rule as modules/rbac/assignments.service.ts);
 *   · every new row bumps organizations.rbac_version so live sessions re-read
 *     their scope on the next request.
 * Authorisation (caller scope ⊆, level ≤, self-assignment, SoD) is the job of
 * the caller / modules/rbac: this primitive only guarantees tenancy and shape.
 * The audit trail is written by `recordRoleAssigned` AFTER the transaction
 * commits (an audit row of a rolled-back grant would be a lie).
 */
export async function writeRoleAssignment(db: RbacDb, input: RoleAssignmentWriteInput): Promise<RoleAssignmentWritten> {
  const now = input.now ?? new Date();
  const role = await db.role.findFirst({
    where: { id: input.roleId, organizationId: input.organizationId },
    select: { id: true, name: true, templateKey: true }
  });
  if (!role || role.templateKey === "break_glass") {
    throw new NotFoundError("Rol no encontrado.");
  }

  let ref: string;
  let propertyId: string | null = null;
  switch (input.scopeType) {
    case "property": {
      if (!input.scopeRef) throw new BadRequestError("El ámbito property exige la propiedad.");
      const property = await db.property.findFirst({ where: { id: input.scopeRef, organizationId: input.organizationId }, select: { id: true } });
      if (!property) throw new NotFoundError("Propiedad no encontrada.");
      ref = property.id;
      propertyId = property.id;
      break;
    }
    case "property_group": {
      if (!input.scopeRef) throw new BadRequestError("El ámbito property_group exige el grupo de propiedades.");
      const group = await db.propertyGroup.findFirst({ where: { id: input.scopeRef, organizationId: input.organizationId }, select: { id: true } });
      if (!group) throw new NotFoundError("Grupo de propiedades no encontrado.");
      ref = group.id;
      break;
    }
    case "legal_entity": {
      if (!input.scopeRef) throw new BadRequestError("El ámbito legal_entity exige la sociedad.");
      const entity = await db.legalEntity.findFirst({ where: { id: input.scopeRef, organizationId: input.organizationId }, select: { id: true } });
      if (!entity) throw new NotFoundError("Sociedad no encontrada.");
      ref = entity.id;
      break;
    }
    case "organization":
      ref = input.organizationId;
      break;
    default:
      throw new BadRequestError("Ámbito no válido.");
  }

  const user = await db.user.findFirst({ where: { id: input.userId, organizationId: input.organizationId }, select: { id: true, status: true } });
  if (!user || user.status === "emergency") {
    throw new NotFoundError("Usuario no encontrado.");
  }

  let legacyCreated = false;
  if (propertyId) {
    const legacy = await db.userPropertyRole.findFirst({ where: { userId: user.id, propertyId, roleId: role.id }, select: { id: true } });
    if (!legacy) {
      await db.userPropertyRole.create({ data: { userId: user.id, propertyId, roleId: role.id } });
      legacyCreated = true;
    }
  }

  const tuple = {
    userId: user.id,
    roleId: role.id,
    scopeType: input.scopeType,
    propertyId,
    propertyGroupId: input.scopeType === "property_group" ? ref : null,
    legalEntityId: input.scopeType === "legal_entity" ? ref : null
  };
  const existing = await db.userRoleAssignment.findFirst({
    where: { ...tuple, organizationId: input.organizationId, revokedAt: null },
    orderBy: { createdAt: "desc" }
  });
  const live = existing && (!existing.validTo || existing.validTo > now) ? existing : null;
  const row =
    live ??
    (await db.userRoleAssignment.create({
      data: {
        ...tuple,
        organizationId: input.organizationId,
        validFrom: now,
        validTo: input.validTo ?? null,
        grantedByUserId: input.grantedByUserId ?? null,
        reason: input.reason ?? null
      }
    }));
  if (live === null || legacyCreated) {
    await bumpRbacVersion(input.organizationId, db);
  }
  return {
    assignmentId: row.id,
    created: live === null,
    legacyCreated,
    userId: user.id,
    organizationId: input.organizationId,
    roleId: role.id,
    roleName: role.name,
    templateKey: knownTemplateKey(role.templateKey),
    scopeType: input.scopeType,
    ref,
    propertyId,
    reason: row.reason ?? null
  };
}

/**
 * ROLE_ASSIGNED audit row for a grant written by `writeRoleAssignment` — call
 * it after the transaction committed. Nothing is written for an idempotent
 * re-run (`created === false`). `actorUserId` null / undefined = system
 * (bootstrap, seeds, backfill: `actorType: "system"`).
 */
export function recordRoleAssigned(
  written: RoleAssignmentWritten,
  actor: { actorUserId?: string | null; correlationId?: string; deviceId?: string; ipAddress?: string; extra?: Record<string, unknown> } = {}
): void {
  if (!written.created) return;
  recordAuditEvent({
    organizationId: written.organizationId,
    propertyId: written.propertyId ?? undefined,
    actorUserId: actor.actorUserId ?? undefined,
    actorType: actor.actorUserId ? "user" : "system",
    action: "ROLE_ASSIGNED",
    entityType: "user_role_assignment",
    entityId: written.assignmentId,
    afterJson: {
      userId: written.userId,
      roleId: written.roleId,
      roleName: written.roleName,
      templateKey: written.templateKey,
      scopeType: written.scopeType,
      ref: written.ref,
      propertyId: written.propertyId,
      reason: written.reason,
      legacyRow: written.propertyId ? (written.legacyCreated ? "created" : "existing") : null,
      ...(actor.extra ?? {})
    },
    deviceId: actor.deviceId,
    ipAddress: actor.ipAddress,
    correlationId: actor.correlationId
  });
}

export async function createUser(input: CreateUserInput): Promise<CreateUserResult> {
  const password = typeof input.password === "string" && input.password.length > 0 ? input.password : null;

  // Política de contraseñas (solo cuando el alta trae contraseña).
  if (password !== null) {
    assertPasswordPolicy(password);
  }

  const status: CreateUserResult["status"] = password !== null ? "active" : "invited";
  // Tanda 8a (§5.5): an invitation always carries a role — without one the
  // invitee would hold zero permissions everywhere in production. Refused
  // BEFORE any write so no orphan `invited` row is left behind.
  if (status === "invited" && (!input.roleId || !input.propertyId)) {
    throw new BadRequestError("El rol y la propiedad son obligatorios para invitar: sin rol la persona invitada no tendría permisos.");
  }

  // Tenencia: org del actor, rol y propiedad de la misma org, sin escalada.
  await assertCreateUserTenancy(input);

  // Email único
  const existing = await prisma.user.findUnique({ where: { email: input.email.toLowerCase().trim() } });
  if (existing) {
    throw new ConflictError("Ya existe un usuario con este email.");
  }

  const actorUserId = input.createdByUserId ?? input.actorContext?.userId ?? null;
  // User + initial assignment (both tables, Tanda 8a dual-write) in ONE
  // transaction: a failed grant never leaves a user without its role.
  const { user, assignment } = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        organizationId: input.organizationId,
        email: input.email.toLowerCase().trim(),
        fullName: input.fullName.trim(),
        phone: input.phone?.trim(),
        // With a password chosen at creation there is nothing to rotate; an
        // invited account has no hash until acceptInvitation sets one.
        passwordHash: password !== null ? hashPassword(password) : null,
        passwordChangedAt: password !== null ? new Date() : null,
        mustChangePassword: false,
        status
      }
    });
    const written =
      input.propertyId && input.roleId
        ? await writeRoleAssignment(tx, {
            userId: created.id,
            organizationId: input.organizationId,
            roleId: input.roleId,
            scopeType: "property",
            scopeRef: input.propertyId,
            grantedByUserId: actorUserId,
            reason: "alta de usuario"
          })
        : null;
    return { user: created, assignment: written };
  });

  recordAuditEvent({
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    actorUserId: actorUserId ?? undefined,
    actorType: actorUserId ? "user" : "system",
    action: "USER_CREATED",
    entityType: "user",
    entityId: user.id,
    afterJson: { email: user.email, fullName: user.fullName, status, propertyId: input.propertyId, roleId: input.roleId, assignmentId: assignment?.assignmentId ?? null },
    correlationId: "create_user"
  });
  if (assignment) {
    recordRoleAssigned(assignment, { actorUserId, correlationId: "create_user", deviceId: input.actorContext?.deviceId });
  }

  if (status === "active") {
    return { id: user.id, email: user.email, fullName: user.fullName, status, ...(assignment ? { assignmentId: assignment.assignmentId } : {}) };
  }

  // Persisted first, invitation second: createInvitation never throws because
  // of the email (delivery.status carries simulated/failed/disabled) — only a
  // DB failure would surface here, and then the user row exists for a reissue.
  const { createInvitation } = await import("./invitations.service.js");
  const invitation = await createInvitation({
    userId: user.id,
    organizationId: input.organizationId,
    propertyId: input.propertyId ?? null,
    roleId: input.roleId ?? null,
    scopeType: "property",
    scopeRef: input.propertyId ?? null,
    invitedByUserId: actorUserId,
    actorUserId,
    correlationId: "create_user"
  });
  return { id: user.id, email: user.email, fullName: user.fullName, status, invitation, ...(assignment ? { assignmentId: assignment.assignmentId } : {}) };
}

// ============================================================ lockout

export type LockoutCheck = {
  isLocked: boolean;
  remainingMinutes?: number;
  attemptsLeft?: number;
};

export async function checkAccountLockout(userId: string): Promise<LockoutCheck> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { failedLoginAttempts: true, lockedUntil: true }
  });
  if (!user) return { isLocked: false };
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const remainingMs = user.lockedUntil.getTime() - Date.now();
    return {
      isLocked: true,
      remainingMinutes: Math.ceil(remainingMs / 60000)
    };
  }
  return {
    isLocked: false,
    attemptsLeft: Math.max(0, MAX_FAILED_ATTEMPTS - user.failedLoginAttempts)
  };
}

export async function recordFailedLogin(userId: string): Promise<{ locked: boolean; attemptsLeft: number }> {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginAttempts: { increment: 1 } },
    select: { failedLoginAttempts: true, organizationId: true }
  });
  if (user.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
    await prisma.user.update({
      where: { id: userId },
      data: { lockedUntil }
    });
    recordAuditEvent({
      organizationId: user.organizationId,
      actorType: "system",
      action: "ACCOUNT_LOCKED",
      entityType: "user",
      entityId: userId,
      afterJson: { failedAttempts: user.failedLoginAttempts, lockedUntil: lockedUntil.toISOString() },
      correlationId: "lockout"
    });
    return { locked: true, attemptsLeft: 0 };
  }
  return { locked: false, attemptsLeft: MAX_FAILED_ATTEMPTS - user.failedLoginAttempts };
}

export async function recordSuccessfulLogin(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date()
    }
  });
}

// ============================================================ password reset

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const PASSWORD_RESET_TEMPLATE_CODE = "password_reset";

export async function requestPasswordReset(input: { email: string }): Promise<{
  // The raw token travels ONLY in the 'password_reset' email. It is returned
  // here solely under the explicit test flag AUTH_EXPOSE_RESET_TOKEN=true.
  resetTokenForTesting?: string;
  expiresAt: string;
  /** Honest outcome of the email (sent | simulated | failed | disabled). */
  delivery: InvitationDelivery;
} | null> {
  const user = await prisma.user.findUnique({
    where: { email: input.email.toLowerCase().trim() },
    select: { id: true, status: true, organizationId: true, email: true, fullName: true }
  });
  // No revelar si el email existe (anti-enumeration). Siempre respondemos OK.
  if (!user) {
    return null;
  }

  // Tanda 3: an invitee has no password to reset. "He olvidado mi contraseña"
  // from an invited account re-sends the invitation instead (best-effort, same
  // neutral HTTP response so the two cases are indistinguishable outside).
  if (user.status === "invited") {
    try {
      const { reissueInvitation } = await import("./invitations.service.js");
      await reissueInvitation({ userId: user.id, organizationId: user.organizationId, actorUserId: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[auth] could not reissue the invitation for invited user ${user.id}: ${message}`);
    }
    return null;
  }
  if (user.status !== "active") {
    return null;
  }

  // Invalida tokens previos del mismo user (un solo reset activo a la vez)
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() }
  });

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
  const tokenRow = await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt
    }
  });

  const delivery = await deliverPasswordResetEmail({ user, token, tokenRowId: tokenRow.id });

  recordAuditEvent({
    organizationId: user.organizationId,
    actorType: "system",
    action: "PASSWORD_RESET_REQUESTED",
    entityType: "user",
    entityId: user.id,
    afterJson: {
      expiresAt: expiresAt.toISOString(),
      delivery: { status: delivery.status, provider: delivery.provider ?? null, errorMessage: delivery.errorMessage ?? null }
    },
    correlationId: "pwd_reset"
  });

  // The plain token is only surfaced under an explicit test flag — never keyed
  // on NODE_ENV, which a deploy can forget to set (AUTH-06).
  if (process.env.AUTH_EXPOSE_RESET_TOKEN === "true") {
    return { resetTokenForTesting: token, expiresAt: expiresAt.toISOString(), delivery };
  }
  return { expiresAt: expiresAt.toISOString(), delivery };
}

/**
 * Best-effort 'password_reset' email through the notification dispatcher
 * (system template fallback when the org has none). Never throws: the token
 * row is already persisted, and the caller records the outcome in the audit
 * event. The raw token is redacted from the stored delivery afterwards.
 */
async function deliverPasswordResetEmail(input: {
  user: { id: string; organizationId: string; email: string; fullName: string };
  token: string;
  tokenRowId: string;
}): Promise<InvitationDelivery> {
  const { buildPasswordResetUrl, classifyDelivery, redactSecretInDelivery } = await import("./invitations.service.js");
  const status = emailStatus();
  let delivery: NotificationDeliveryRecord | null = null;
  let failure: string | null = null;
  try {
    delivery = await dispatch({
      organizationId: input.user.organizationId,
      templateCode: PASSWORD_RESET_TEMPLATE_CODE,
      channel: "email",
      recipient: input.user.email,
      notificationId: `pwd_reset:${input.tokenRowId}`,
      language: "es",
      variables: {
        resetUrl: buildPasswordResetUrl(input.token),
        userName: input.user.fullName,
        expiryMinutes: RESET_TOKEN_TTL_MINUTES
      }
    });
  } catch (error) {
    // Honest catch (QC-06): logged and surfaced in delivery.errorMessage; the
    // reset token stays valid for the AUTH_EXPOSE_RESET_TOKEN test path.
    failure = error instanceof Error ? error.message : String(error);
    console.error(`[auth] password reset email failed for user ${input.user.id}: ${failure}`);
  }
  await redactSecretInDelivery(delivery, input.token);
  return classifyDelivery(delivery, failure, status);
}

export async function resetPassword(input: { token: string; newPassword: string }): Promise<{ userId: string }> {
  assertPasswordPolicy(input.newPassword);

  const tokenHash = hashToken(input.token);
  const tokenRow = await prisma.passwordResetToken.findUnique({
    where: { tokenHash }
  });
  if (!tokenRow) {
    throw new BadRequestError("Token de reset inválido.");
  }
  if (tokenRow.usedAt) {
    throw new BadRequestError("Este token ya ha sido usado.");
  }
  if (tokenRow.expiresAt < new Date()) {
    throw new BadRequestError("Token expirado. Solicita uno nuevo.");
  }

  const newHash = hashPassword(input.newPassword);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: tokenRow.userId },
      data: {
        passwordHash: newHash,
        passwordChangedAt: new Date(),
        // A self-chosen password clears the forced-rotation flag (Tanda 3).
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: null
      }
    }),
    prisma.passwordResetToken.update({
      where: { id: tokenRow.id },
      data: { usedAt: new Date() }
    }),
    // SECURITY (audit 2026-06): a reset usually follows account compromise —
    // revoke every active session so the attacker's JWTs die at once
    // (loadUserContext validates the session row in the DB on each request).
    prisma.session.updateMany({
      where: { userId: tokenRow.userId, status: "active" },
      data: { status: "revoked", revokedAt: new Date() }
    })
  ]);

  const user = await prisma.user.findUnique({
    where: { id: tokenRow.userId },
    select: { organizationId: true }
  });
  if (user) {
    recordAuditEvent({
      organizationId: user.organizationId,
      actorType: "system",
      action: "PASSWORD_RESET_COMPLETED",
      entityType: "user",
      entityId: tokenRow.userId,
      afterJson: {},
      correlationId: "pwd_reset"
    });
  }

  return { userId: tokenRow.userId };
}

// ============================================================ change password (logged-in user)

export async function changeOwnPassword(input: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  assertPasswordPolicy(input.newPassword);
  const { verifyPassword } = await import("@hotelos/database");
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { passwordHash: true, organizationId: true }
  });
  if (!user || !verifyPassword(input.currentPassword, user.passwordHash)) {
    throw new UnauthorizedError("Contraseña actual incorrecta.");
  }
  const newHash = hashPassword(input.newPassword);
  await prisma.user.update({
    where: { id: input.userId },
    data: {
      passwordHash: newHash,
      passwordChangedAt: new Date(),
      // Tanda 3: rotating the temp password lifts the PASSWORD_CHANGE_REQUIRED
      // guard (loadUserContext re-derives the flag on the next request).
      mustChangePassword: false
    }
  });
  // SECURITY (audit 2026-06): invalidate all existing sessions on password
  // change so any other logged-in device is signed out (defense against a
  // lingering compromised session). The user re-authenticates once.
  await prisma.session.updateMany({
    where: { userId: input.userId, status: "active" },
    data: { status: "revoked", revokedAt: new Date() }
  });
  recordAuditEvent({
    organizationId: user.organizationId,
    actorUserId: input.userId,
    actorType: "user",
    action: "PASSWORD_CHANGED",
    entityType: "user",
    entityId: input.userId,
    afterJson: {},
    correlationId: "pwd_change"
  });
}

// ============================================================ constants export

export const AUTH_PILOT_CONFIG = {
  PASSWORD_MIN_LENGTH,
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_MINUTES,
  RESET_TOKEN_TTL_MINUTES
} as const;
