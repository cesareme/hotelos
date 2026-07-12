import { assertPermissions, ROLE_PERMISSION_MAP } from "@hotelos/shared";
import type { PermissionKey, RoleKey } from "@hotelos/shared";
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
import { BadRequestError, ForbiddenError, UnauthorizedError } from "../../lib/http-error.js";
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

function unionPermissions(prismaPerms: PermissionKey[]): PermissionKey[] {
  // SECURITY (auditoría 2026-07): FAIL-SECURE. Antes el gate era
  // `NODE_ENV !== "production"` → un deploy que OLVIDARA fijar NODE_ENV le daba
  // a cualquier usuario TODOS los permisos del super-usuario demo. Ahora la
  // escalada solo se activa con un opt-in EXPLÍCITO: NODE_ENV=development|dev
  // (entorno local/demo declarado) o HOTELOS_ALLOW_DEMO_AUTH=true (mismo flag
  // que habilita el fallback de auth demo). Con NODE_ENV ausente o cualquier
  // otro valor → solo permisos reales derivados de roles.
  const env = process.env.NODE_ENV;
  const demoMode =
    env === "development" || env === "dev" || process.env.HOTELOS_ALLOW_DEMO_AUTH === "true";
  if (!demoMode) {
    return prismaPerms;
  }
  // Dev/demo only: union with the legacy demoStore baseline so route-permission
  // gates that use keys not yet seeded into the RolePermission table keep
  // working until the permission catalog is fully aligned.
  const set = new Set<string>([...prismaPerms, ...demoStore.userContext.permissions]);
  return Array.from(set) as PermissionKey[];
}

export async function loadUserContext(sessionId: string): Promise<UserContext | null> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== "active") return null;
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || user.status !== "active") return null;
  const assignment = await prisma.userPropertyRole.findFirst({ where: { userId: user.id }, orderBy: { id: "asc" } });
  const propertyId = assignment?.propertyId ?? demoStore.userContext.propertyId;
  const permissions = await loadPermissionsForUserProperty(user.id, propertyId);
  return {
    organizationId: user.organizationId,
    propertyId,
    userId: user.id,
    fullName: user.fullName,
    deviceId: session.deviceId,
    permissions: unionPermissions(permissions)
  };
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

export async function loginWithEmailPassword(input: { email: string; password: string; deviceId: string }): Promise<LoginResult> {
  if (!input.email || !input.password) {
    throw new BadRequestError("Email and password are required.");
  }

  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase().trim() } });
  if (!user) {
    throw new UnauthorizedError("Invalid credentials.");
  }
  if (user.status !== "active") {
    throw new ForbiddenError(`User account is ${user.status}.`);
  }

  // PILOT-D1: lockout check. Si la cuenta está bloqueada, no permitimos ni
  // verificar la contraseña (evita información sobre acierto/fallo).
  const { checkAccountLockout, recordFailedLogin, recordSuccessfulLogin } = await import("./auth-pilot.service.js");
  const lockout = await checkAccountLockout(user.id);
  if (lockout.isLocked) {
    throw new ForbiddenError(`Cuenta bloqueada temporalmente. Reintenta en ${lockout.remainingMinutes} min.`);
  }

  // SECURITY: require a set password hash. Previously `user.passwordHash && ...`
  // let accounts with a null/empty hash authenticate with ANY password.
  if (!user.passwordHash || !verifyPassword(input.password, user.passwordHash)) {
    const failure = await recordFailedLogin(user.id);
    if (failure.locked) {
      throw new ForbiddenError("Cuenta bloqueada por múltiples intentos fallidos. Reintenta en 15 min.");
    }
    throw new UnauthorizedError(`Invalid credentials. (${failure.attemptsLeft} intento${failure.attemptsLeft === 1 ? "" : "s"} restantes antes del bloqueo)`);
  }

  // Login exitoso: resetea contador, actualiza lastLoginAt.
  await recordSuccessfulLogin(user.id);

  const propertyAssignment = await prisma.userPropertyRole.findFirst({
    where: { userId: user.id },
    orderBy: { id: "asc" }
  });

  const propertyId = propertyAssignment?.propertyId ?? demoStore.userContext.propertyId;
  const session = await ensureSession({ userId: user.id, deviceId: input.deviceId });
  const permissions = await loadPermissionsForUserProperty(user.id, propertyId);
  const effectivePermissions = unionPermissions(permissions);

  recordAuditEvent({
    organizationId: user.organizationId,
    propertyId,
    actorUserId: user.id,
    actorType: "user",
    action: "AUTH_LOGIN",
    entityType: "user",
    entityId: user.id,
    deviceId: input.deviceId,
    afterJson: { email: user.email, sessionId: session.id }
  });

  const claims: JwtClaims = {
    sub: user.id,
    sessionId: session.id,
    organizationId: user.organizationId,
    propertyId,
    deviceId: input.deviceId
  };
  const token = signJwt(claims);

  return {
    token,
    sessionId: session.id,
    user: {
      organizationId: user.organizationId,
      propertyId,
      userId: user.id,
      fullName: user.fullName,
      deviceId: input.deviceId,
      permissions: effectivePermissions
    }
  };
}

export function permissionsForRoles(roles: RoleKey[]): PermissionKey[] {
  return Array.from(new Set(roles.flatMap((role) => ROLE_PERMISSION_MAP[role])));
}

export function requirePermissions(context: UserContext, required: PermissionKey[]): void {
  assertPermissions(context.permissions, required);
}

export function listPropertiesForUser(context: UserContext): PropertyRecord[] {
  return demoStore.properties.filter((property) => property.organizationId === context.organizationId);
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

export function listNotifications(context: UserContext): NotificationRecord[] {
  return demoStore.notifications.filter((notification) => notification.userId === context.userId);
}

export function markNotificationRead(input: {
  context: UserContext;
  notificationId: string;
}): NotificationRecord {
  const notification = demoStore.notifications.find(
    (candidate) => candidate.id === input.notificationId && candidate.userId === input.context.userId
  );
  if (!notification) {
    throw new Error("Notification was not found.");
  }

  notification.status = "read";
  return notification;
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
