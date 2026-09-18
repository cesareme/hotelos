// RBAC por departamento (Tanda 8a · L1) · «break glass» auditado (design §4.8).
//
// Dos cuentas por organización sin persona (`emergencia-1@`, `emergencia-2@`,
// status "emergency": nunca entran por contraseña — loginWithEmailPassword las
// rechaza con 403). Abrir: desde una sesión REAL con security.break_glass y
// re-autenticación obligatoria (contraseña del abridor + confirmHighRisk, y el
// código TOTP si tiene MFA) → rol «Emergencia» (ensureBreakGlassRole: todas
// las claves de organización, nunca plataforma) asignado a la cuenta de
// emergencia con validTo = cierre, sesión real de 4 h (createSessionForUser),
// fila break_glass_sessions ligada al Session, evento BREAK_GLASS_OPENED y
// notificación a dirección general / administración / auditoría si existe
// plantilla de notificación; si no, solo auditoría (se anota en la respuesta).
// Cada petición de esa sesión lleva `bg_<id>_<corr>` como correlación
// (server.ts) y loadUserContext la mata sola al llegar closesAt. Cerrar: quien
// abrió, dirección general, administración de sistema, auditoría (o la propia
// sesión) revoca sesión y asignación → BREAK_GLASS_CLOSED. Revisión en 24 h
// (reviewBreakGlass: audit.read Y una asignación viva de dirección general,
// administración de sistema o auditoría interna — las mismas plantillas que
// reciben la alerta y pueden cerrarla —, nunca quien la abrió ni un supervisor
// de hotel con audit.read; corrector 8a · SEC-8A-04). El listado también es de
// organización. Una sesión de emergencia nunca abre otra ni concede accesos
// permanentes (RBAC_BREAK_GLASS_FORBIDDEN).

import { BREAK_GLASS_MAX_SESSION_HOURS, type BreakGlassSessionDto, type RoleKey } from "@hotelos/shared";
import { verifyPassword } from "@hotelos/database";
import { createId } from "../../lib/ids.js";
import type { UserContext } from "../../lib/demo-store.js";
import { ConflictError, NotFoundError, RbacForbiddenError } from "../../lib/http-error.js";
import { ensureBreakGlassRole } from "../../lib/rbac-catalog.js";
import { bumpRbacVersion } from "../../lib/rbac-scope.js";
import { createSessionForUser, requirePermissions, verifyMfaChallenge, type LoginResult } from "../auth/auth.service.js";
import { dispatch } from "../notifications/dispatcher.service.js";
import { assertNotBreakGlass, defaultRbacDeps, isBreakGlassContext, scopeOfContext, type RbacDeps } from "./assignments.service.js";

export const BREAK_GLASS_NOT_FOUND = "Sesión de emergencia no encontrada.";
/** Prefixes of the two emergency accounts of an organisation (§4.8). */
export const BREAK_GLASS_ACCOUNT_PREFIXES = ["emergencia-1@", "emergencia-2@"] as const;
/** Templates notified when a session opens (and allowed to close it). */
export const BREAK_GLASS_NOTIFIED_TEMPLATES: readonly RoleKey[] = ["general_manager", "admin", "auditor"];
export const BREAK_GLASS_TEMPLATE_CODE = "break_glass_opened";

/** Collaborators the break-glass flow can swap in tests (the session and MFA come from auth.service against the global client). */
export type BreakGlassDeps = RbacDeps & {
  createSession: typeof createSessionForUser;
  verifyMfa: typeof verifyMfaChallenge;
  ensureRole: typeof ensureBreakGlassRole;
  notify: typeof dispatch;
};

export const defaultBreakGlassDeps: BreakGlassDeps = { ...defaultRbacDeps, createSession: createSessionForUser, verifyMfa: verifyMfaChallenge, ensureRole: ensureBreakGlassRole, notify: dispatch };

type SessionRow = {
  id: string;
  organizationId: string;
  openedByUserId: string;
  accountUserId: string;
  sessionId: string | null;
  reason: string;
  ticket: string | null;
  openedAt: Date;
  closesAt: Date;
  closedAt: Date | null;
  closedByUserId: string | null;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
};

function toDto(row: SessionRow): BreakGlassSessionDto {
  return {
    id: row.id,
    organizationId: row.organizationId,
    openedByUserId: row.openedByUserId,
    accountUserId: row.accountUserId,
    reason: row.reason,
    ticket: row.ticket,
    openedAt: row.openedAt.toISOString(),
    closesAt: row.closesAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    closedByUserId: row.closedByUserId,
    reviewedByUserId: row.reviewedByUserId,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null
  };
}

function reauthRequired(detail: string): RbacForbiddenError {
  return new RbacForbiddenError("Abrir una sesión de emergencia exige volver a autenticarse.", "BREAK_GLASS_REAUTH_REQUIRED", { detail });
}

export type OpenBreakGlassInput = {
  context: UserContext;
  reason: string;
  ticket?: string;
  password?: string;
  confirmHighRisk?: boolean;
  mfaChallengeId?: string;
  code?: string;
  ipAddress?: string;
};

export type OpenBreakGlassResult = {
  session: BreakGlassSessionDto;
  token: string;
  sessionId: string;
  user: LoginResult["user"];
  notification: { attempted: number; delivered: number; note: string | null };
};

export async function openBreakGlass(input: OpenBreakGlassInput, deps: BreakGlassDeps = defaultBreakGlassDeps): Promise<OpenBreakGlassResult> {
  const { context } = input;
  assertNotBreakGlass(context);
  requirePermissions(context, ["security.break_glass"]);
  const organizationId = context.organizationId;
  const db = deps.db;
  const opener = await db.user.findFirst({ where: { id: context.userId, organizationId }, select: { id: true, email: true, fullName: true, passwordHash: true, mfaEnabled: true, status: true } });
  if (!opener || opener.status !== "active") throw new NotFoundError("Usuario no encontrado.");
  // Mandatory re-authentication: password + explicit confirmation (+ TOTP when the opener has MFA).
  if (input.confirmHighRisk !== true) throw reauthRequired("confirmHighRisk");
  if (!input.password || !opener.passwordHash || !verifyPassword(input.password, opener.passwordHash)) throw reauthRequired("password");
  if (opener.mfaEnabled) {
    if (!input.mfaChallengeId || !input.code) throw reauthRequired("mfa");
    try {
      await deps.verifyMfa({ context, challengeId: input.mfaChallengeId, code: input.code });
    } catch {
      throw reauthRequired("mfa");
    }
  }
  const now = deps.now();
  const closesAt = new Date(now.getTime() + BREAK_GLASS_MAX_SESSION_HOURS * 60 * 60 * 1000);
  // A free emergency account of the organisation (status "emergency", not inside an open session).
  const accounts = await db.user.findMany({ where: { organizationId, status: "emergency" }, select: { id: true, email: true, fullName: true, organizationId: true, mustChangePassword: true, passwordHash: true, passwordChangedAt: true, status: true }, orderBy: { email: "asc" } });
  const emergency = accounts.filter((account) => BREAK_GLASS_ACCOUNT_PREFIXES.some((prefix) => account.email.toLowerCase().startsWith(prefix)));
  if (emergency.length === 0) throw new ConflictError("No existe una cuenta de emergencia disponible.", { code: "BREAK_GLASS_ACCOUNT_MISSING", reason: "missing" });
  const busy = (await db.breakGlassSession.findMany({ where: { organizationId, accountUserId: { in: emergency.map((account) => account.id) }, closedAt: null, closesAt: { gt: now } }, select: { accountUserId: true } })).map((row) => row.accountUserId);
  const account = emergency.find((candidate) => !busy.includes(candidate.id));
  if (!account) throw new ConflictError("No existe una cuenta de emergencia disponible.", { code: "BREAK_GLASS_ACCOUNT_MISSING", reason: "busy" });

  const role = await deps.ensureRole(organizationId, { db });
  const assignment = await db.userRoleAssignment.create({
    data: { userId: account.id, roleId: role.id, scopeType: "organization", organizationId, validFrom: now, validTo: closesAt, grantedByUserId: opener.id, reason: `break_glass: ${input.reason}` }
  });
  await bumpRbacVersion(organizationId, db);
  const login = await deps.createSession({ user: account, deviceId: createId("bg"), auditAction: "BREAK_GLASS_SESSION", ipAddress: input.ipAddress });
  const row = (await db.breakGlassSession.create({
    data: { organizationId, openedByUserId: opener.id, accountUserId: account.id, sessionId: login.sessionId, reason: input.reason, ticket: input.ticket ?? null, openedAt: now, closesAt }
  })) as SessionRow;
  deps.audit({
    organizationId,
    actorUserId: opener.id,
    actorType: "user",
    action: "BREAK_GLASS_OPENED",
    entityType: "break_glass_session",
    entityId: row.id,
    afterJson: { accountUserId: account.id, sessionId: login.sessionId, assignmentId: assignment.id, roleId: role.id, reason: input.reason, ticket: input.ticket ?? null, closesAt: closesAt.toISOString() },
    ipAddress: input.ipAddress,
    deviceId: context.deviceId,
    correlationId: `bg_${row.id}`
  });

  // Immediate notification to general management / system administration / internal audit.
  const notification = { attempted: 0, delivered: 0, note: null as string | null };
  try {
    const recipients = await notificationRecipients(organizationId, deps);
    notification.attempted = recipients.length;
    if (recipients.length === 0) notification.note = "sin destinatarios: ninguna asignación viva de dirección general, administración de sistema o auditoría";
    for (const recipient of recipients) {
      try {
        await deps.notify({
          organizationId,
          templateCode: BREAK_GLASS_TEMPLATE_CODE,
          channel: "email",
          recipient,
          variables: { reason: input.reason, ticket: input.ticket ?? "", openedBy: opener.fullName, account: account.email, closesAt: closesAt.toISOString() },
          notificationId: `${row.id}:${recipient}`
        });
        notification.delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notification.note = message === "template_not_found" ? `sin plantilla de notificación «${BREAK_GLASS_TEMPLATE_CODE}»: solo auditoría` : `notificación no enviada: ${message}`;
      }
    }
  } catch (error) {
    notification.note = `notificación no enviada: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { session: toDto(row), token: login.token, sessionId: login.sessionId, user: login.user, notification };
}

async function notificationRecipients(organizationId: string, deps: RbacDeps): Promise<string[]> {
  const roles = await deps.db.role.findMany({ where: { organizationId, templateKey: { in: [...BREAK_GLASS_NOTIFIED_TEMPLATES] } }, select: { id: true } });
  if (roles.length === 0) return [];
  const now = deps.now();
  const assignments = await deps.db.userRoleAssignment.findMany({ where: { organizationId, roleId: { in: roles.map((role) => role.id) }, revokedAt: null, OR: [{ validTo: null }, { validTo: { gt: now } }] }, select: { userId: true } });
  const legacy = await deps.db.userPropertyRole.findMany({ where: { roleId: { in: roles.map((role) => role.id) } }, select: { userId: true } });
  const userIds = [...new Set([...assignments.map((row) => row.userId), ...legacy.map((row) => row.userId)])];
  if (userIds.length === 0) return [];
  const users = await deps.db.user.findMany({ where: { id: { in: userIds }, organizationId, status: "active" }, select: { email: true } });
  return users.map((user) => user.email);
}

/** True when the context may close the session: opener, general management, system admin, internal audit, platform, or the session itself. */
async function mayClose(context: UserContext, row: SessionRow, deps: RbacDeps): Promise<boolean> {
  if (context.userId === row.openedByUserId) return true;
  if (context.isPlatformAdmin === true) return true;
  if (isBreakGlassContext(context) && context.breakGlassSessionId === row.id) return true;
  const scope = await scopeOfContext(context, deps);
  return scope.assignments.some((assignment) => assignment.templateKey !== null && BREAK_GLASS_NOTIFIED_TEMPLATES.includes(assignment.templateKey));
}

async function closeRow(row: SessionRow, closedByUserId: string | null, reason: "manual" | "expired", deps: RbacDeps, ipAddress?: string, deviceId?: string): Promise<BreakGlassSessionDto> {
  const now = deps.now();
  if (row.sessionId) await deps.db.session.updateMany({ where: { id: row.sessionId, status: "active" }, data: { status: "revoked", revokedAt: now } });
  await deps.db.userRoleAssignment.updateMany({ where: { userId: row.accountUserId, organizationId: row.organizationId, scopeType: "organization", revokedAt: null }, data: { revokedAt: now, revokedByUserId: closedByUserId, reason: `break_glass_closed:${reason}` } });
  const updated = (await deps.db.breakGlassSession.update({ where: { id: row.id }, data: { closedAt: now, closedByUserId } })) as SessionRow;
  deps.audit({
    organizationId: row.organizationId,
    actorUserId: closedByUserId ?? undefined,
    actorType: closedByUserId ? "user" : "system",
    action: "BREAK_GLASS_CLOSED",
    entityType: "break_glass_session",
    entityId: row.id,
    beforeJson: { openedAt: row.openedAt.toISOString(), closesAt: row.closesAt.toISOString() },
    afterJson: { closedAt: now.toISOString(), reason, accountUserId: row.accountUserId, sessionId: row.sessionId },
    ipAddress,
    deviceId,
    correlationId: `bg_${row.id}`
  });
  await bumpRbacVersion(row.organizationId, deps.db);
  return toDto(updated);
}

export async function closeBreakGlass(input: { context: UserContext; id: string; ipAddress?: string }, deps: RbacDeps = defaultRbacDeps): Promise<BreakGlassSessionDto> {
  const { context } = input;
  const row = (await deps.db.breakGlassSession.findFirst({ where: { id: input.id, organizationId: context.organizationId } })) as SessionRow | null;
  if (!row) throw new NotFoundError(BREAK_GLASS_NOT_FOUND);
  if (!(await mayClose(context, row, deps))) throw new NotFoundError(BREAK_GLASS_NOT_FOUND);
  if (row.closedAt) return toDto(row);
  return closeRow(row, context.userId, "manual", deps, input.ipAddress, context.deviceId);
}

/** Idempotent sweep: every open session past its window is closed (loadUserContext already refuses it). */
export async function expireBreakGlass(deps: RbacDeps = defaultRbacDeps, organizationId?: string): Promise<number> {
  const now = deps.now();
  const rows = (await deps.db.breakGlassSession.findMany({ where: { closedAt: null, closesAt: { lt: now }, ...(organizationId ? { organizationId } : {}) } })) as SessionRow[];
  for (const row of rows) await closeRow(row, null, "expired", deps);
  return rows.length;
}

/** True when the context may REVIEW a session (§4.8): platform, or a live assignment of a notified template (DG / admin / auditor) — never the opener, never a break-glass session. */
async function mayReview(context: UserContext, row: SessionRow, deps: RbacDeps): Promise<boolean> {
  if (isBreakGlassContext(context)) return false;
  if (context.isPlatformAdmin === true) return true;
  if (context.userId === row.openedByUserId) return false;
  const scope = await scopeOfContext(context, deps);
  return scope.assignments.some((assignment) => assignment.templateKey !== null && BREAK_GLASS_NOTIFIED_TEMPLATES.includes(assignment.templateKey));
}

export async function reviewBreakGlass(input: { context: UserContext; id: string }, deps: RbacDeps = defaultRbacDeps): Promise<BreakGlassSessionDto> {
  const { context } = input;
  requirePermissions(context, ["audit.read"]);
  const row = (await deps.db.breakGlassSession.findFirst({ where: { id: input.id, organizationId: context.organizationId } })) as SessionRow | null;
  if (!row) throw new NotFoundError(BREAK_GLASS_NOT_FOUND);
  if (!(await mayReview(context, row, deps))) {
    throw new RbacForbiddenError("La revisión de una sesión de emergencia corresponde a dirección general, administración de sistema o auditoría interna (nunca a quien la abrió).", "RBAC_SCOPE_EXCEEDED");
  }
  if (row.reviewedAt) return toDto(row);
  const now = deps.now();
  const updated = (await deps.db.breakGlassSession.update({ where: { id: row.id }, data: { reviewedByUserId: context.userId, reviewedAt: now } })) as SessionRow;
  deps.audit({ organizationId: row.organizationId, actorUserId: context.userId, actorType: "user", action: "BREAK_GLASS_REVIEWED", entityType: "break_glass_session", entityId: row.id, afterJson: { reviewedAt: now.toISOString() }, deviceId: context.deviceId, correlationId: `bg_${row.id}` });
  return toDto(updated);
}

export async function listBreakGlass(input: { context: UserContext }, deps: RbacDeps = defaultRbacDeps): Promise<BreakGlassSessionDto[]> {
  requirePermissions(input.context, ["audit.read"]);
  // Emergency sessions are organisation-level rows: only organisation-wide readers list them (SEC-8A-03).
  if (input.context.isPlatformAdmin !== true && !(await scopeOfContext(input.context, deps)).orgScope) {
    throw new RbacForbiddenError("Las sesiones de emergencia son de toda la organización: exige una asignación de sociedad u organización.", "RBAC_SCOPE_EXCEEDED");
  }
  await expireBreakGlass(deps, input.context.organizationId);
  const rows = (await deps.db.breakGlassSession.findMany({ where: { organizationId: input.context.organizationId }, orderBy: { openedAt: "desc" }, take: 200 })) as SessionRow[];
  return rows.map(toDto);
}
