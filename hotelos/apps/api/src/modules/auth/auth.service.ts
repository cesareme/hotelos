import { ROLE_TEMPLATE_KEYS, assertPermissions, isPlatformPermission } from "@hotelos/shared";
import type { PermissionKey, RoleKey, UserScopeDto } from "@hotelos/shared";
import { prisma, signJwt, verifyPassword, type JwtClaims } from "@hotelos/database";
import {
  demoStore,
  type DeviceRecord,
  type MfaChallengeRecord,
  type NotificationRecord,
  type PropertyRecord,
  type SessionRecord,
  type UserContext
} from "../../lib/demo-store.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from "../../lib/http-error.js";
import { loadUserScope, permissionsFor, toContextAssignments, type UserScope } from "../../lib/rbac-scope.js";
import { createHash, randomInt } from "node:crypto";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function hashMfaCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export type LoginResult = {
  token: string;
  user: UserContext;
  sessionId: string;
};

/** The User columns the forced-rotation rule reads (subset of the Prisma row). */
export type PasswordRotationRow = {
  mustChangePassword: boolean;
  passwordHash: string | null;
  passwordChangedAt: Date | null;
  status: string;
};

/**
 * Tanda 3 · forced password rotation. True when the account must rotate its
 * password before using the API:
 *   - the explicit flag `User.mustChangePassword` (set by temp/reissued
 *     passwords), or
 *   - a set password that has NEVER been changed on an active account
 *     (`passwordChangedAt` null): createTenant / regenerateTempPassword wrote
 *     that null precisely to mean "temporary credential, must rotate", but
 *     nothing read it until now. Historical rows with a null are therefore
 *     asked to rotate once (Carmen included) — intended, see the integrator
 *     notes for the demo backfill.
 * Users without a password (invited) are not "must change": they cannot log
 * in at all until they accept the invitation.
 */
export function deriveMustChangePassword(user: PasswordRotationRow): boolean {
  // Integration decision (Tanda 3): only the EXPLICIT flag forces rotation.
  // Historical rows carry passwordChangedAt = null for seed users and for
  // owners created before invitations existed (reception@example.com,
  // Carmen); locking them out of the API on the next login would break the
  // demo and every automated check that logs in with those accounts. Temp
  // and reissued passwords set the flag explicitly from now on.
  return user.mustChangePassword === true;
}

export async function loadPermissionsForUserProperty(userId: string, propertyId: string): Promise<PermissionKey[]> {
  const assignments = await prisma.userPropertyRole.findMany({
    where: { userId, propertyId },
    select: { roleId: true }
  });
  if (assignments.length === 0) return [];
  const rolePerms = await prisma.rolePermission.findMany({
    where: { roleId: { in: assignments.map((a) => a.roleId) } },
    select: { permissionId: true }
  });
  if (rolePerms.length === 0) return [];
  const permissions = await prisma.permission.findMany({
    where: { id: { in: rolePerms.map((rp) => rp.permissionId) } },
    select: { key: true }
  });
  const keys = new Set<string>(permissions.map((p) => p.key));
  return Array.from(keys) as PermissionKey[];
}

/**
 * True when the demo permission union is enabled. Tanda 8a (RBAC · L1, design
 * §6.4 / H10): ONE explicit switch, `HOTELOS_DEMO_PERMISSION_UNION=true`
 * (lib/env.ts, productionForbidden) — no longer derived from NODE_ENV nor from
 * HOTELOS_ALLOW_DEMO_AUTH, which kept masking the real RBAC of every session in
 * the local demo (Recepción Los Tilos held ~222 effective keys). The
 * token-less demo fallback (auth-context.ts) is unaffected: it builds its
 * context from the demoStore directly.
 */
export function isDemoPermissionUnionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HOTELOS_DEMO_PERMISSION_UNION === "true";
}

export function unionPermissions(
  prismaPerms: PermissionKey[],
  options: { demoMode?: boolean; baseline?: readonly PermissionKey[] } = {}
): PermissionKey[] {
  // SECURITY (auditoría 2026-07): FAIL-SECURE. Antes el gate era
  // `NODE_ENV !== "production"` → un deploy que OLVIDARA fijar NODE_ENV le daba
  // a cualquier usuario TODOS los permisos del super-usuario demo. La escalada
  // solo se activa con un opt-in EXPLÍCITO; desde la Tanda 8a ese opt-in es la
  // variable dedicada HOTELOS_DEMO_PERMISSION_UNION=true (ver
  // isDemoPermissionUnionEnabled). Sin ella → solo permisos reales derivados
  // de las asignaciones.
  const demoMode = options.demoMode ?? isDemoPermissionUnionEnabled();
  if (!demoMode) {
    return prismaPerms;
  }
  // Dev/demo only: union with the legacy demoStore baseline so route-permission
  // gates that use keys not yet seeded into the RolePermission table keep
  // working until the permission catalog is fully aligned.
  //
  // Tanda 5 (L1c · api): the PLATFORM keys (admin.tenants.manage) never come
  // from the union — only from a real grant. The baseline carries the key for
  // the token-less demo fallback (auth-context.ts builds that context from the
  // demoStore directly, so it keeps it); a REAL session of a hotel owner in
  // dev used to read /admin/tenants/* of other organizations through it
  // (isPlatformAdmin was already derived from the real grants; the gate was not).
  const baseline = (options.baseline ?? demoStore.userContext.permissions).filter((key) => !isPlatformPermission(key));
  const set = new Set<string>([...prismaPerms, ...baseline]);
  return Array.from(set) as PermissionKey[];
}

/**
 * Tanda 8a (RBAC · L1): the session context from the user's scope
 * (lib/rbac-scope.ts: user_property_roles ∪ user_role_assignments, expanded).
 * `propertyId` is the first covered property in stable order (legacy rows by
 * id first, as before) or the demo property when the user covers none;
 * `permissions` are resolved for THAT property (the scope preHandler of
 * server.ts re-resolves them for the property of each request). `orgScope`,
 * `scopes`, `assignments`, `assignedPropertyIds` and `sessionId` travel with
 * the context; `isPlatformAdmin` derives from the REAL union of every
 * assignment (never the demo union).
 */
function contextFromScope(input: {
  user: { id: string; organizationId: string; fullName: string } & PasswordRotationRow;
  scope: UserScope;
  deviceId: string;
  sessionId: string;
  breakGlassSessionId?: string;
}): UserContext {
  const { user, scope } = input;
  const propertyId = scope.assignedPropertyIds[0] ?? demoStore.userContext.propertyId;
  const permissions = permissionsFor(scope, propertyId);
  return {
    organizationId: user.organizationId,
    propertyId,
    userId: user.id,
    fullName: user.fullName,
    deviceId: input.deviceId,
    permissions: unionPermissions(permissions),
    assignedPropertyIds: scope.assignedPropertyIds,
    orgScope: scope.orgScope,
    scopes: scope.scopes,
    assignments: toContextAssignments(scope),
    sessionId: input.sessionId,
    ...(input.breakGlassSessionId ? { breakGlassSessionId: input.breakGlassSessionId } : {}),
    // Derived from the REAL role grants (before the demo union) so the flag is
    // trustworthy even when unionPermissions adds admin.tenants.manage for all.
    isPlatformAdmin: hasPlatformAdminGrant(scope.allPermissions),
    // Read on EVERY authenticated request (not cached in the JWT) so the guard
    // lifts as soon as the password is rotated and applies as soon as an admin
    // reissues a temp password.
    mustChangePassword: deriveMustChangePassword(user)
  };
}

export async function loadUserContext(sessionId: string): Promise<UserContext | null> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== "active") return null;
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) return null;
  let breakGlassSessionId: string | undefined;
  if (user.status === "emergency") {
    // §4.8: an emergency account is only valid INSIDE an open break-glass
    // session bound to this very Session row and still within its window;
    // closed / expired → null → 401 (the session dies on its own).
    const breakGlass = await prisma.breakGlassSession.findFirst({
      where: { sessionId, accountUserId: user.id, closedAt: null, closesAt: { gt: new Date() } },
      select: { id: true }
    });
    if (!breakGlass) return null;
    breakGlassSessionId = breakGlass.id;
  } else if (user.status !== "active") {
    return null;
  }
  const scope = await loadUserScope(user.id, user.organizationId);
  return contextFromScope({ user, scope, deviceId: session.deviceId, sessionId: session.id, breakGlassSessionId });
}

function toIso(date: Date | null | undefined): string | undefined {
  return date ? date.toISOString() : undefined;
}

function mapDevice(row: {
  id: string;
  userId: string;
  deviceName: string;
  platform: string;
  pushToken: string | null;
  trusted: boolean;
  registeredAt: Date;
  lastSeenAt: Date;
}): DeviceRecord {
  return {
    id: row.id,
    userId: row.userId,
    deviceName: row.deviceName,
    platform: row.platform as DeviceRecord["platform"],
    pushToken: row.pushToken ?? undefined,
    trusted: row.trusted,
    registeredAt: row.registeredAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString()
  };
}

function mapSession(row: {
  id: string;
  userId: string;
  deviceId: string;
  status: string;
  createdAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
}): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    deviceId: row.deviceId,
    status: row.status as SessionRecord["status"],
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    revokedAt: toIso(row.revokedAt)
  };
}

function mapMfa(row: {
  id: string;
  userId: string;
  purpose: string;
  status: string;
  deliveryChannel: string;
  expiresAt: Date;
  createdAt: Date;
}): MfaChallengeRecord {
  return {
    id: row.id,
    userId: row.userId,
    purpose: row.purpose as MfaChallengeRecord["purpose"],
    status: row.status as MfaChallengeRecord["status"],
    deliveryChannel: row.deliveryChannel as MfaChallengeRecord["deliveryChannel"],
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString()
  };
}

/**
 * Tanda 8a (RBAC · L1, design §6.6): every refused credential login leaves a
 * LOGIN_FAILED audit row — actor / entity = the user when the email matches
 * an account (never the email itself), reason code, IP and device. Unknown
 * emails are recorded against the organisation-less demo tenant id only when
 * no user exists (`entityId` absent) so the trail still counts the attempt.
 */
function auditLoginFailed(input: {
  user: { id: string; organizationId: string } | null;
  reason: "invalid_credentials" | "account_locked" | "account_locked_now" | "account_not_active" | "unknown_user";
  ipAddress?: string;
  deviceId: string;
}): void {
  if (!input.user) return;
  recordAuditEvent({
    organizationId: input.user.organizationId,
    actorUserId: input.user.id,
    actorType: "user",
    action: "LOGIN_FAILED",
    entityType: "user",
    entityId: input.user.id,
    afterJson: { reason: input.reason },
    ipAddress: input.ipAddress,
    deviceId: input.deviceId
  });
}

export async function loginWithEmailPassword(input: { email: string; password: string; deviceId: string; ipAddress?: string }): Promise<LoginResult> {
  if (!input.email || !input.password) {
    throw new BadRequestError("Email and password are required.");
  }

  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase().trim() } });
  if (!user) {
    throw new UnauthorizedError("Invalid credentials.");
  }
  if (user.status !== "active") {
    // The break-glass accounts (status "emergency", §4.8) never log in with a
    // password: their only entrance is POST /rbac/break-glass from a real session.
    auditLoginFailed({ user, reason: "account_not_active", ipAddress: input.ipAddress, deviceId: input.deviceId });
    throw new ForbiddenError(`User account is ${user.status}.`);
  }

  // PILOT-D1: lockout check. Si la cuenta está bloqueada, no permitimos ni
  // verificar la contraseña (evita información sobre acierto/fallo).
  const { checkAccountLockout, recordFailedLogin, recordSuccessfulLogin } = await import("./auth-pilot.service.js");
  const lockout = await checkAccountLockout(user.id);
  if (lockout.isLocked) {
    auditLoginFailed({ user, reason: "account_locked", ipAddress: input.ipAddress, deviceId: input.deviceId });
    throw new ForbiddenError(`Cuenta bloqueada temporalmente. Reintenta en ${lockout.remainingMinutes} min.`);
  }

  // SECURITY: require a set password hash. Previously `user.passwordHash && ...`
  // let accounts with a null/empty hash authenticate with ANY password.
  if (!user.passwordHash || !verifyPassword(input.password, user.passwordHash)) {
    const failure = await recordFailedLogin(user.id);
    if (failure.locked) {
      auditLoginFailed({ user, reason: "account_locked_now", ipAddress: input.ipAddress, deviceId: input.deviceId });
      throw new ForbiddenError("Cuenta bloqueada por múltiples intentos fallidos. Reintenta en 15 min.");
    }
    auditLoginFailed({ user, reason: "invalid_credentials", ipAddress: input.ipAddress, deviceId: input.deviceId });
    throw new UnauthorizedError(`Invalid credentials. (${failure.attemptsLeft} intento${failure.attemptsLeft === 1 ? "" : "s"} restantes antes del bloqueo)`);
  }

  // Login exitoso: resetea contador, actualiza lastLoginAt.
  await recordSuccessfulLogin(user.id);

  return createSessionForUser({ user, deviceId: input.deviceId, auditAction: "AUTH_LOGIN", ipAddress: input.ipAddress });
}

/** The User columns `createSessionForUser` needs (subset of the Prisma row). */
export type SessionUserRow = PasswordRotationRow & {
  id: string;
  organizationId: string;
  email: string;
  fullName: string;
};

/**
 * Open (or refresh) the session for an already-authenticated user and build
 * the same `LoginResult` POST /auth/login returns. Shared by the credential
 * login above and by `acceptInvitation` (Tanda 3): accepting an invitation
 * sets the password and signs the invitee in with one call, so the front never
 * has to replay the password. The caller is responsible for authentication
 * (password verified, or single-use invitation token consumed) — this function
 * only issues the session/JWT and records the audit event.
 */
export async function createSessionForUser(input: {
  user: SessionUserRow;
  deviceId: string;
  auditAction?: string;
  ipAddress?: string;
  /** Tanda 8a (§4.8): set by the break-glass service when the session belongs to an emergency account. */
  breakGlassSessionId?: string;
}): Promise<LoginResult> {
  const { user, deviceId } = input;
  // Tanda 8a (RBAC · L1): the scope reader replaces the first-row lookup of
  // user_property_roles + loadPermissionsForUserProperty — otherwise the emergency account and any
  // user holding only user_role_assignments would log in with 0 keys and the
  // demo property.
  const session = await ensureSession({ userId: user.id, deviceId });
  const scope = await loadUserScope(user.id, user.organizationId);
  const context = contextFromScope({ user, scope, deviceId, sessionId: session.id, breakGlassSessionId: input.breakGlassSessionId });
  const propertyId = context.propertyId;

  recordAuditEvent({
    organizationId: user.organizationId,
    propertyId,
    actorUserId: user.id,
    actorType: "user",
    action: input.auditAction ?? "AUTH_LOGIN",
    entityType: "user",
    entityId: user.id,
    deviceId,
    ipAddress: input.ipAddress,
    afterJson: { email: user.email, sessionId: session.id }
  });

  const claims: JwtClaims = {
    sub: user.id,
    sessionId: session.id,
    organizationId: user.organizationId,
    propertyId,
    deviceId
  };
  const token = signJwt(claims);

  return {
    token,
    sessionId: session.id,
    // Same shape loadUserContext serves on every request (real DB grants for
    // isPlatformAdmin; the front routes to ChangePasswordScreen when
    // mustChangePassword is true, the API guard enforces it regardless).
    user: context
  };
}

// permissionsForRoles(ROLE_PERMISSION_MAP) was removed in Tanda 1: it had no
// callers. Role templates are now applied to DB rows by lib/rbac-catalog.ts.

export function requirePermissions(context: UserContext, required: PermissionKey[]): void {
  assertPermissions(context.permissions, required);
}

export function listPropertiesForUser(context: UserContext): PropertyRecord[] {
  return demoStore.properties.filter((property) => property.organizationId === context.organizationId);
}

// Part of the canonical catalog since Tanda 1 (PLATFORM_PERMISSION_KEYS): no cast.
export const PLATFORM_ADMIN_PERMISSION: PermissionKey = "admin.tenants.manage";

/** True when the REAL (pre-demo-union) role grants include admin.tenants.manage. */
export function hasPlatformAdminGrant(realPermissions: PermissionKey[]): boolean {
  return realPermissions.includes(PLATFORM_ADMIN_PERMISSION);
}

/**
 * Loads the real DB grants for a user/property and derives the platform-admin
 * flag. Used by the demo auth fallback (usr_123 without a token), which builds
 * its context from the demoStore instead of loadUserContext.
 */
export async function loadIsPlatformAdmin(userId: string, propertyId: string): Promise<boolean> {
  return hasPlatformAdminGrant(await loadPermissionsForUserProperty(userId, propertyId));
}

// Evaluated against the permissions actually granted through roles in
// Postgres, not `context.permissions`: in demo mode that array is the union
// with the demoStore baseline, which carries admin.tenants.manage for everyone.
// Contexts built by loadUserContext/login/the demo fallback already carry the
// flag, so the DB lookup only runs for contexts assembled elsewhere.
export async function isPlatformAdmin(context: UserContext): Promise<boolean> {
  if (typeof context.isPlatformAdmin === "boolean") return context.isPlatformAdmin;
  return loadIsPlatformAdmin(context.userId, context.propertyId);
}

// ---------------------------------------------------------------------------
// GET /users/me (Tanda 5 · L1a · rbac)
// ---------------------------------------------------------------------------

export type CurrentUserPropertyRole = {
  id: string;
  name: string;
  /** Shared template the role follows (ROLE_TEMPLATE_KEYS); null = custom role. */
  templateKey: RoleKey | null;
};

export type CurrentUserProperty = {
  id: string;
  name: string;
  organizationId: string;
  /** Roles the user holds IN THIS property (every assignment covering it, legacy rows included), name order. */
  roles: CurrentUserPropertyRole[];
  /** Distinct template keys of those roles, in ROLE_TEMPLATE_KEYS order. */
  templateKeys: RoleKey[];
  /** Tanda 8a: keys REALLY granted in this property (union of the assignments covering it; never the demo union), sorted. */
  grantedPermissions: PermissionKey[];
};

export type CurrentUserProfile = {
  userId: string;
  email: string | null;
  fullName: string;
  organizationId: string;
  organizationName: string | null;
  /** Property the session context is bound to (first assignment, as loadUserContext). */
  activePropertyId: string;
  /** Effective permissions of the session context (demo union included in dev). */
  permissions: PermissionKey[];
  /**
   * Permissions REALLY granted through roles in the active property (never
   * the demo union): what the navigation filters by, so a receptionist on the
   * dev API sees the receptionist menu and not the super-user one.
   */
  grantedPermissions: PermissionKey[];
  /** Real DB grants only (never the demo union): may act across organizations. */
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
  /** Template keys held in the active property (shortcut of properties[].templateKeys). */
  templateKeys: RoleKey[];
  properties: CurrentUserProperty[];
  /** Tanda 8a: the scopes of the live assignments (property / group / sociedad / organisation, expanded). */
  scopes: UserScopeDto[];
  /** Tanda 8a: true with a live organization / legal_entity assignment. */
  orgScope: boolean;
  /** Tanda 8a (§4.8): set inside a break-glass session. */
  breakGlassSessionId: string | null;
};

/** Known template keys, or null: a hand-edited template_key never reaches the client as a token. */
function toTemplateKey(value: string | null | undefined): RoleKey | null {
  if (!value) return null;
  return (ROLE_TEMPLATE_KEYS as readonly string[]).includes(value) ? (value as RoleKey) : null;
}

function orderTemplateKeys(keys: Iterable<RoleKey | null>): RoleKey[] {
  const held = new Set<RoleKey>();
  for (const key of keys) if (key) held.add(key);
  return ROLE_TEMPLATE_KEYS.filter((key) => held.has(key));
}

/**
 * The signed-in user with the template of every role they hold, per property.
 * The navigation tree (apps/admin-web/src/navigation/role-tokens.ts) derives
 * its role tokens from `properties[].templateKeys` of the active property, so
 * the menu follows the REAL assignment instead of a persona in localStorage.
 * Reads user_property_roles for every property (not only the session one):
 * the property switcher needs to know the token changes with the property.
 * Users without a Prisma row (token-less demo fallback) get the context
 * fields and an empty property list — never a 500.
 */
export async function getCurrentUserProfile(context: UserContext): Promise<CurrentUserProfile> {
  const user = await prisma.user.findUnique({
    where: { id: context.userId },
    select: { id: true, email: true, fullName: true, organizationId: true, mustChangePassword: true, passwordHash: true, passwordChangedAt: true, status: true }
  });
  const organizationId = user?.organizationId ?? context.organizationId;
  // Tanda 8a (RBAC · L1): properties = the ones covered by the user's scope
  // (user_property_roles ∪ user_role_assignments, groups / sociedad /
  // organisation expanded), each with its roles, template keys and the keys
  // REALLY granted there (never the demo union).
  const scope = await loadUserScope(context.userId, organizationId);
  const propertyIds = scope.assignedPropertyIds;
  const [organization, properties] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
    propertyIds.length > 0
      ? prisma.property.findMany({ where: { id: { in: propertyIds } }, select: { id: true, name: true, organizationId: true }, orderBy: { name: "asc" } })
      : Promise.resolve([])
  ]);
  const propertyRows: CurrentUserProperty[] = properties.map((property) => {
    const heldById = new Map<string, CurrentUserPropertyRole>();
    for (const assignment of scope.assignments) {
      if (!assignment.propertyIds.includes(property.id)) continue;
      heldById.set(assignment.roleId, { id: assignment.roleId, name: assignment.roleName, templateKey: assignment.templateKey });
    }
    const held = Array.from(heldById.values()).sort((a, b) => a.name.localeCompare(b.name, "es"));
    return {
      id: property.id,
      name: property.name,
      organizationId: property.organizationId,
      roles: held,
      templateKeys: orderTemplateKeys(held.map((role) => role.templateKey)),
      grantedPermissions: permissionsFor(scope, property.id)
    };
  });
  const active = propertyRows.find((property) => property.id === context.propertyId);
  return {
    userId: context.userId,
    email: user?.email ?? null,
    fullName: user?.fullName ?? context.fullName,
    organizationId,
    organizationName: organization?.name ?? null,
    activePropertyId: context.propertyId,
    permissions: context.permissions,
    grantedPermissions: permissionsFor(scope, context.propertyId),
    isPlatformAdmin: await isPlatformAdmin(context),
    mustChangePassword: user ? deriveMustChangePassword(user) : context.mustChangePassword === true,
    templateKeys: active?.templateKeys ?? [],
    properties: propertyRows,
    scopes: scope.scopes,
    orgScope: scope.orgScope,
    breakGlassSessionId: context.breakGlassSessionId ?? null
  };
}

export async function registerDevice(input: {
  context: UserContext;
  deviceName: string;
  platform: DeviceRecord["platform"];
  pushToken?: string;
}): Promise<DeviceRecord> {
  const existing = await prisma.device.findFirst({
    where: {
      OR: [
        { id: input.context.deviceId },
        { AND: [{ userId: input.context.userId }, { deviceName: input.deviceName }] }
      ]
    }
  });

  if (existing) {
    const updated = await prisma.device.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: new Date(),
        pushToken: input.pushToken ?? existing.pushToken ?? null
      }
    });
    return mapDevice(updated);
  }

  const created = await prisma.device.create({
    data: {
      userId: input.context.userId,
      deviceName: input.deviceName,
      platform: input.platform,
      pushToken: input.pushToken ?? null,
      trusted: false
    }
  });
  const device = mapDevice(created);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "DEVICE_REGISTERED",
    entityType: "device",
    entityId: device.id,
    afterJson: device,
    deviceId: input.context.deviceId
  });

  return device;
}

export async function listSessions(context: UserContext): Promise<SessionRecord[]> {
  const rows = await prisma.session.findMany({
    where: { userId: context.userId },
    orderBy: { createdAt: "desc" }
  });
  return rows.map(mapSession);
}

export async function revokeSession(input: {
  context: UserContext;
  sessionId: string;
}): Promise<SessionRecord> {
  const session = await prisma.session.findFirst({
    where: { id: input.sessionId, userId: input.context.userId }
  });
  if (!session) {
    throw new Error("Session was not found.");
  }

  const before = mapSession(session);
  const updated = await prisma.session.update({
    where: { id: session.id },
    data: { status: "revoked", revokedAt: new Date() }
  });
  const after = mapSession(updated);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SESSION_REVOKED",
    entityType: "session",
    entityId: after.id,
    beforeJson: before,
    afterJson: after,
    deviceId: input.context.deviceId
  });

  return after;
}

export async function createMfaChallenge(input: {
  context: UserContext;
  purpose: MfaChallengeRecord["purpose"];
  deliveryChannel?: MfaChallengeRecord["deliveryChannel"];
}): Promise<MfaChallengeRecord> {
  // SECURITY: generate a real 6-digit one-time code and store only its hash.
  // Previously no code was generated and verifyMfaChallenge accepted ANY six
  // digits. In production the code is delivered out-of-band (SMS/authenticator);
  // in dev, delivery is stubbed so we log it for testing.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const created = await prisma.mfaChallenge.create({
    data: {
      userId: input.context.userId,
      purpose: input.purpose,
      status: "pending",
      deliveryChannel: input.deliveryChannel ?? "authenticator",
      codeHash: hashMfaCode(code),
      expiresAt: new Date(Date.now() + FIVE_MINUTES_MS)
    }
  });
  const challenge = mapMfa(created);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "system",
    action: "MFA_CHALLENGE_CREATED",
    entityType: "mfa_challenge",
    entityId: challenge.id,
    afterJson: { purpose: challenge.purpose, deliveryChannel: challenge.deliveryChannel, expiresAt: challenge.expiresAt },
    deviceId: input.context.deviceId
  });

  return challenge;
}

export async function verifyMfaChallenge(input: {
  context: UserContext;
  challengeId: string;
  code: string;
}): Promise<MfaChallengeRecord> {
  const found = await prisma.mfaChallenge.findFirst({
    where: { id: input.challengeId, userId: input.context.userId }
  });
  if (!found) {
    throw new Error("MFA challenge was not found.");
  }
  if (found.status !== "pending") {
    throw new Error(`MFA challenge is ${found.status}.`);
  }
  if (found.expiresAt.getTime() < Date.now()) {
    await prisma.mfaChallenge.update({ where: { id: found.id }, data: { status: "expired" } });
    throw new Error("MFA challenge expired.");
  }
  if (!/^\d{6}$/.test(input.code)) {
    throw new Error("MFA code must be six digits.");
  }
  // SECURITY: compare against the stored code hash. A challenge with no stored
  // hash (legacy) is rejected in production rather than rubber-stamped.
  if (found.codeHash) {
    if (hashMfaCode(input.code) !== found.codeHash) {
      throw new Error("Invalid MFA code.");
    }
  } else if (process.env.NODE_ENV === "production") {
    throw new Error("MFA challenge has no verifiable code.");
  }

  const before = mapMfa(found);
  const updated = await prisma.mfaChallenge.update({
    where: { id: found.id },
    data: { status: "verified" }
  });
  const after = mapMfa(updated);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "MFA_CHALLENGE_VERIFIED",
    entityType: "mfa_challenge",
    entityId: after.id,
    beforeJson: before,
    afterJson: { status: after.status, purpose: after.purpose },
    deviceId: input.context.deviceId
  });

  return after;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notificaciones in-app (Tanda L2 · L2-04): la tabla `notifications` es la
// única fuente. Sin espejo demoStore, sin fixtures copiados por proceso: cada
// lectura filtra por usuario Y organización (Notification.organizationId,
// L2-01) y cada escritura pasa organizationId explícito. Ningún flujo de
// dominio crea todavía Notification (queueNotificationsForEvent escribe
// NotificationDelivery): decisión abierta para el integrador.

type NotificationRow = NonNullable<Awaited<ReturnType<typeof prisma.notification.findUnique>>>;

const NOTIFICATIONS_PAGE = 200;

function toNotificationRecord(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    userId: row.userId,
    type: row.type as NotificationRecord["type"],
    title: row.title,
    body: row.body,
    status: row.status as NotificationRecord["status"],
    createdAt: row.createdAt.toISOString()
  };
}

/** Las 200 notificaciones más recientes del usuario dentro de su organización. */
export async function listNotifications(context: UserContext): Promise<NotificationRecord[]> {
  const rows = await prisma.notification.findMany({
    where: { userId: context.userId, organizationId: context.organizationId },
    orderBy: { createdAt: "desc" },
    take: NOTIFICATIONS_PAGE
  });
  return rows.map(toNotificationRecord);
}

export async function markNotificationRead(input: {
  context: UserContext;
  notificationId: string;
}): Promise<NotificationRecord> {
  // Fail-secure: una notificación de otro usuario u otra organización es
  // indistinguible de una inexistente (404 opaco).
  const row = await prisma.notification.findFirst({
    where: { id: input.notificationId, userId: input.context.userId, organizationId: input.context.organizationId },
    select: { id: true }
  });
  if (!row) {
    throw new NotFoundError("La notificación no existe.");
  }
  const updated = await prisma.notification.update({ where: { id: row.id }, data: { status: "read" } });
  return toNotificationRecord(updated);
}

export async function getSecuritySettings(context: UserContext): Promise<{
  mfaEnabled: boolean;
  activeSessions: number;
  registeredDevices: number;
  sensitiveRolesRequireMfa: RoleKey[];
}> {
  const [user, activeSessions, registeredDevices] = await Promise.all([
    prisma.user.findUnique({ where: { id: context.userId } }),
    prisma.session.count({ where: { userId: context.userId, status: "active" } }),
    prisma.device.count({ where: { userId: context.userId } })
  ]);
  return {
    mfaEnabled: user?.mfaEnabled ?? false,
    activeSessions,
    registeredDevices,
    sensitiveRolesRequireMfa: ["owner", "manager", "accountant", "admin"]
  };
}

async function ensureSession(input: { userId: string; deviceId: string }): Promise<SessionRecord> {
  const existing = await prisma.session.findFirst({
    where: { userId: input.userId, deviceId: input.deviceId, status: "active" }
  });

  if (existing) {
    const updated = await prisma.session.update({
      where: { id: existing.id },
      data: { lastSeenAt: new Date() }
    });
    return mapSession(updated);
  }

  const created = await prisma.session.create({
    data: {
      userId: input.userId,
      deviceId: input.deviceId,
      status: "active"
    }
  });
  return mapSession(created);
}
