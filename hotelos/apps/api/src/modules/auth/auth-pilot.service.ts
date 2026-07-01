// PILOT-D1 · Endurecimiento de autenticación para piloto real.
//
// Añade sobre el módulo auth original:
//   1. createUser({...})         · onboarding de cuentas reales
//   2. validatePasswordPolicy()  · min 8, mayúsculas, número, especial
//   3. lockout                   · 5 fallos consecutivos → 15min bloqueo
//   4. password reset flow       · token TTL 15min + hashing
//   5. recordSuccessfulLogin     · resetea contador, actualiza lastLoginAt
//
// El flujo de login original llama a estas funciones (modificación mínima
// en loginWithEmailPassword) para que cualquier intento pase por el lockout.

import { createHash, randomBytes } from "node:crypto";
import { prisma, hashPassword } from "@hotelos/database";
import { recordAuditEvent } from "../audit/audit.service.js";
import { BadRequestError, ConflictError, UnauthorizedError } from "../../lib/http-error.js";

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
  password: string;
  fullName: string;
  phone?: string;
  // Asignación inicial a una property con un rol existente.
  propertyId?: string;
  roleId?: string;
  // Información de auditoría: quién está creando este usuario.
  createdByUserId?: string;
};

export async function createUser(input: CreateUserInput): Promise<{ id: string; email: string; fullName: string }> {
  // Política de contraseñas
  assertPasswordPolicy(input.password);

  // Email único
  const existing = await prisma.user.findUnique({ where: { email: input.email.toLowerCase().trim() } });
  if (existing) {
    throw new ConflictError("Ya existe un usuario con este email.");
  }

  const passwordHash = hashPassword(input.password);
  const user = await prisma.user.create({
    data: {
      organizationId: input.organizationId,
      email: input.email.toLowerCase().trim(),
      fullName: input.fullName.trim(),
      phone: input.phone?.trim(),
      passwordHash,
      passwordChangedAt: new Date(),
      status: "active"
    }
  });

  // Asignar a property + role si se proveyó.
  if (input.propertyId && input.roleId) {
    await prisma.userPropertyRole.create({
      data: {
        userId: user.id,
        propertyId: input.propertyId,
        roleId: input.roleId
      }
    });
  }

  recordAuditEvent({
    organizationId: input.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.createdByUserId,
    actorType: input.createdByUserId ? "user" : "system",
    action: "USER_CREATED",
    entityType: "user",
    entityId: user.id,
    afterJson: { email: user.email, fullName: user.fullName, propertyId: input.propertyId, roleId: input.roleId },
    correlationId: "create_user"
  });

  return { id: user.id, email: user.email, fullName: user.fullName };
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

export async function requestPasswordReset(input: { email: string }): Promise<{
  // En producción este token va en email/SMS. Nunca lo devuelvas en API,
  // solo lo logueamos para test en sandbox.
  resetTokenForTesting?: string;
  expiresAt: string;
} | null> {
  const user = await prisma.user.findUnique({
    where: { email: input.email.toLowerCase().trim() },
    select: { id: true, status: true, organizationId: true }
  });
  // No revelar si el email existe (anti-enumeration). Siempre respondemos OK.
  if (!user || user.status !== "active") {
    return null;
  }

  // Invalida tokens previos del mismo user (un solo reset activo a la vez)
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() }
  });

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt
    }
  });

  recordAuditEvent({
    organizationId: user.organizationId,
    actorType: "system",
    action: "PASSWORD_RESET_REQUESTED",
    entityType: "user",
    entityId: user.id,
    afterJson: { expiresAt: expiresAt.toISOString() },
    correlationId: "pwd_reset"
  });

  // En sandbox (NODE_ENV !== production) devolvemos el token plano para testing.
  // En producción se envía por email — nunca aparece en la respuesta.
  if (process.env.NODE_ENV !== "production") {
    return { resetTokenForTesting: token, expiresAt: expiresAt.toISOString() };
  }
  return { expiresAt: expiresAt.toISOString() };
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
      passwordChangedAt: new Date()
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
