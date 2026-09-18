// RBAC por departamento (Tanda 8a · L1) · PIN de supervisor (design §5.6,
// patrón OPERA): cuando un operativo lanza una acción que exige una clave
// *.override / *_approve que no tiene, un supervisor PRESENTE autoriza esa
// acción concreta con su PIN. La autorización dura 60 s, es de un solo uso y
// queda ligada a (actor, clave, entidad); el evento SUPERVISOR_AUTHORIZED
// registra actor, autorizador, motivo, importe e IP.
//
// Seguridad: el PIN se guarda con el mismo scrypt de las contraseñas
// (hashPassword / verifyPassword de @hotelos/database); 5 fallos → bloqueo de
// 15 min persistido (pinFailedAttempts / pinLockedUntil); un fallo NUNCA
// distingue la causa (autorizador inexistente, de otra organización, sin la
// clave, sin PIN, PIN erróneo → SUPERVISOR_PIN_INVALID); el bloqueo sí se
// comunica (423 SUPERVISOR_PIN_LOCKED) para que el supervisor no se siga
// bloqueando. Fijar el PIN propio exige la contraseña del usuario.

import { hashPassword, verifyPassword } from "@hotelos/database";
import { PERMISSIONS, SUPERVISOR_AUTHORIZATION_TTL_SECONDS, type PermissionKey, type SupervisorAuthorizationDto } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, HttpError, NotFoundError, RbacForbiddenError } from "../../lib/http-error.js";
import { loadUserScope, permissionsFor } from "../../lib/rbac-scope.js";
import { requirePermissions } from "../auth/auth.service.js";
import { assertNotBreakGlass, defaultRbacDeps, type RbacDeps } from "./assignments.service.js";

export const PIN_MAX_FAILED_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 15;
const PIN_PATTERN = /^\d{4,8}$/;

type AuthorizationRow = {
  id: string;
  organizationId: string;
  propertyId: string | null;
  actorUserId: string;
  authorizerUserId: string;
  permissionKey: string;
  entityType: string;
  entityId: string;
  amount: { toString(): string } | null;
  reasonCode: string;
  expiresAt: Date;
  usedAt: Date | null;
};

function toDto(row: AuthorizationRow): SupervisorAuthorizationDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    actorUserId: row.actorUserId,
    authorizerUserId: row.authorizerUserId,
    permissionKey: row.permissionKey as PermissionKey,
    entityType: row.entityType,
    entityId: row.entityId,
    amount: row.amount === null ? null : row.amount.toString(),
    reasonCode: row.reasonCode,
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt ? row.usedAt.toISOString() : null
  };
}

function pinInvalid(): RbacForbiddenError {
  return new RbacForbiddenError("PIN de supervisor incorrecto.", "SUPERVISOR_PIN_INVALID");
}

/** 423 Locked with `details.code = SUPERVISOR_PIN_LOCKED` (the front tells the supervisor to wait). */
function pinLocked(until: Date): HttpError {
  return new HttpError(423, "PIN de supervisor bloqueado temporalmente.", true, { code: "SUPERVISOR_PIN_LOCKED", lockedUntil: until.toISOString() });
}

/** POST /rbac/pin — the signed-in user sets its own PIN after proving the password. */
export async function setOwnPin(input: { context: UserContext; password: string; pin: string }, deps: RbacDeps = defaultRbacDeps): Promise<{ userId: string; pinUpdatedAt: string }> {
  const { context } = input;
  assertNotBreakGlass(context);
  if (!PIN_PATTERN.test(input.pin)) throw new BadRequestError("El PIN debe tener entre 4 y 8 dígitos.");
  const user = await deps.db.user.findFirst({ where: { id: context.userId, organizationId: context.organizationId }, select: { id: true, passwordHash: true, status: true } });
  if (!user || user.status !== "active") throw new NotFoundError("Usuario no encontrado.");
  if (!user.passwordHash || !verifyPassword(input.password, user.passwordHash)) {
    throw new RbacForbiddenError("La contraseña no es válida.", "BREAK_GLASS_REAUTH_REQUIRED");
  }
  const now = deps.now();
  await deps.db.user.update({ where: { id: user.id }, data: { pinHash: hashPassword(input.pin), pinUpdatedAt: now, pinFailedAttempts: 0, pinLockedUntil: null } });
  deps.audit({
    organizationId: context.organizationId,
    actorUserId: context.userId,
    actorType: "user",
    action: "SUPERVISOR_PIN_SET",
    entityType: "user",
    entityId: user.id,
    afterJson: { pinUpdatedAt: now.toISOString() },
    deviceId: context.deviceId
  });
  return { userId: user.id, pinUpdatedAt: now.toISOString() };
}

export type AuthorizeInput = {
  context: UserContext;
  authorizerEmail: string;
  pin: string;
  permissionKey: string;
  entityType: string;
  entityId: string;
  propertyId: string;
  amount?: string | number | null;
  reasonCode: string;
  ipAddress?: string;
};

/**
 * POST /rbac/supervisor-authorizations — a supervisor present at the desk
 * authorises ONE action of the actor with its PIN. The authoriser must be of
 * the same organisation, a different user, active, hold `permissionKey` in
 * the property (its own scope, never the actor's) and present a valid PIN.
 */
export async function authorize(input: AuthorizeInput, deps: RbacDeps = defaultRbacDeps): Promise<SupervisorAuthorizationDto> {
  const { context } = input;
  if (!(input.permissionKey in PERMISSIONS)) throw new BadRequestError("Clave de permiso desconocida.");
  if (!PIN_PATTERN.test(input.pin)) throw pinInvalid();
  const permissionKey = input.permissionKey as PermissionKey;
  const authorizer = await deps.db.user.findFirst({
    where: { email: input.authorizerEmail.trim().toLowerCase(), organizationId: context.organizationId },
    select: { id: true, status: true, pinHash: true, pinFailedAttempts: true, pinLockedUntil: true }
  });
  // Every "who" failure is the same opaque answer (no oracle on accounts / keys).
  if (!authorizer || authorizer.status !== "active" || authorizer.id === context.userId || !authorizer.pinHash) throw pinInvalid();
  const now = deps.now();
  if (authorizer.pinLockedUntil && authorizer.pinLockedUntil > now) throw pinLocked(authorizer.pinLockedUntil);
  // The authoriser's own scope, in the property the action happens in.
  const scope = await loadUserScope(authorizer.id, context.organizationId, deps.db);
  const held = permissionsFor(scope, input.propertyId);
  try {
    requirePermissions({ ...context, userId: authorizer.id, permissions: held }, [permissionKey]);
  } catch {
    throw pinInvalid();
  }
  if (!verifyPassword(input.pin, authorizer.pinHash)) {
    const attempts = authorizer.pinFailedAttempts + 1;
    if (attempts >= PIN_MAX_FAILED_ATTEMPTS) {
      const until = new Date(now.getTime() + PIN_LOCK_MINUTES * 60_000);
      await deps.db.user.update({ where: { id: authorizer.id }, data: { pinFailedAttempts: 0, pinLockedUntil: until } });
      deps.audit({ organizationId: context.organizationId, propertyId: input.propertyId, actorUserId: context.userId, actorType: "user", action: "SUPERVISOR_PIN_LOCKED", entityType: "user", entityId: authorizer.id, afterJson: { lockedUntil: until.toISOString() }, ipAddress: input.ipAddress, deviceId: context.deviceId });
      throw pinLocked(until);
    }
    await deps.db.user.update({ where: { id: authorizer.id }, data: { pinFailedAttempts: attempts } });
    throw pinInvalid();
  }
  if (authorizer.pinFailedAttempts !== 0 || authorizer.pinLockedUntil) {
    await deps.db.user.update({ where: { id: authorizer.id }, data: { pinFailedAttempts: 0, pinLockedUntil: null } });
  }
  const amount = input.amount === null || input.amount === undefined ? null : Number(input.amount);
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new BadRequestError("El importe debe ser ≥ 0.");
  const created = (await deps.db.supervisorAuthorization.create({
    data: {
      organizationId: context.organizationId,
      propertyId: input.propertyId,
      actorUserId: context.userId,
      authorizerUserId: authorizer.id,
      permissionKey,
      entityType: input.entityType,
      entityId: input.entityId,
      amount: amount === null ? null : amount.toFixed(2),
      reasonCode: input.reasonCode,
      expiresAt: new Date(now.getTime() + SUPERVISOR_AUTHORIZATION_TTL_SECONDS * 1000)
    }
  })) as AuthorizationRow;
  deps.audit({
    organizationId: context.organizationId,
    propertyId: input.propertyId,
    actorUserId: context.userId,
    actorType: "user",
    action: "SUPERVISOR_AUTHORIZED",
    entityType: "supervisor_authorization",
    entityId: created.id,
    afterJson: { authorizerUserId: authorizer.id, permissionKey, entityType: input.entityType, entityId: input.entityId, amount: amount === null ? null : amount.toFixed(2), reasonCode: input.reasonCode, expiresAt: created.expiresAt.toISOString() },
    ipAddress: input.ipAddress,
    deviceId: context.deviceId
  });
  return toDto(created);
}

/**
 * Single use: marks the authorisation as consumed when it is alive and EVERY
 * field matches (actor, permission key, entity); returns null otherwise. Used
 * by L2 services and by assertApprovedOrAuthorized (approvals.service.ts).
 */
export async function consumeSupervisorAuthorization(
  id: string,
  match: { actorUserId: string; permissionKey: string; entityType: string; entityId: string },
  deps: RbacDeps = defaultRbacDeps
): Promise<SupervisorAuthorizationDto | null> {
  const now = deps.now();
  const row = (await deps.db.supervisorAuthorization.findFirst({
    where: { id, actorUserId: match.actorUserId, permissionKey: match.permissionKey, entityType: match.entityType, entityId: match.entityId, usedAt: null, expiresAt: { gt: now } }
  })) as AuthorizationRow | null;
  if (!row) return null;
  const used = (await deps.db.supervisorAuthorization.update({ where: { id: row.id }, data: { usedAt: now } })) as AuthorizationRow;
  return toDto(used);
}
