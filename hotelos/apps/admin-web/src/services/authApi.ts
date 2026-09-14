// Auth + invitations client (Tanda 3 · CFG-P1-6).
//
// Two families of calls live here:
//
//   • PUBLIC legs (no bearer): password policy, invitation preview, accept
//     invite, forgot / reset password. They go through `publicRequest`, a thin
//     fetch wrapper that mirrors apiRequest's error envelope (ApiError with
//     status + details) but never attaches — nor triggers — a session. The
//     demo fallback of apiRequest (auto-login with the seeded account) must
//     NOT run on these screens: a visitor opening /accept-invite has no
//     session and must not be handed one implicitly.
//
//   • AUTHENTICATED legs (bearer via apiRequest): change own password, email
//     delivery status, property roles, backoffice invite / reissue.
//
// Delivery honesty: the API reports how the invitation email actually went
// out (`sent` = a real provider accepted it; `simulated` = dev mode, nothing
// left the box; `disabled`/`failed` = no provider or provider error). Screens
// must only claim "Invitación enviada" for `sent` and otherwise surface the
// copyable `inviteUrl`.

import { apiBase, apiRequest, ApiError, publicRequest } from "./api-client";
import { clearSession, getToken, getUser, type AuthUser } from "./auth-storage";
import { toArray } from "../utils/toArray";

// ---------------------------------------------------------------------------
// Types (mirror apps/api contracts G/H)
// ---------------------------------------------------------------------------

export type PasswordPolicy = {
  minLength: number;
  requireUppercase: boolean;
  requireDigit: boolean;
  requireSpecial: boolean;
  maxFailedAttempts?: number;
  lockoutMinutes?: number;
};

export type InvitationPreview = {
  email: string;
  fullName: string | null;
  organizationName: string;
  propertyName: string | null;
  roleName: string | null;
  expiresAt: string;
};

export type InvitationDeliveryStatus = "sent" | "simulated" | "failed" | "disabled";

export type InvitationDelivery = {
  status: InvitationDeliveryStatus;
  provider?: string;
  errorMessage?: string;
};

export type InvitationResult = {
  inviteUrl: string;
  expiresAt: string;
  delivery: InvitationDelivery;
};

export type EmailStatus = {
  configured: boolean;
  provider: string | null;
  from: string | null;
  mode: "real" | "simulated" | "disabled";
};

/** Same shape as POST /auth/login (the API opens a session on accept). */
export type LoginResponse = {
  token: string;
  sessionId?: string;
  user: AuthUser & { mustChangePassword?: boolean };
};

/** The stored session user may carry the forced-rotation flag from the API. */
export type SessionUser = AuthUser & { mustChangePassword?: boolean };

export type PropertyRole = {
  id: string;
  name: string;
  organizationId?: string;
  description?: string;
  /** Tanda 4: template the role was created from (null = custom) and its effective grant count. */
  templateKey?: string | null;
  permissionsCount?: number;
};

/**
 * Pending-invitation summary carried by GET /backoffice/properties/:id/users
 * for `invited` users (BackOfficePendingInvitationView in
 * apps/api/src/modules/backoffice/backoffice.service.ts). Deliberately
 * token-free: the list never carries the single-use link — `inviteUrl` is
 * always null there and only POST …/reissue-invite mints a fresh one. The UI
 * shows the expiry, how the last email went out and whether it already
 * expired; nothing else is derived from it.
 * `expired` is computed server-side; when an older API omits it the UI derives
 * it from `expiresAt` (see describePendingInvitation).
 */
export type PendingInvitation = {
  expiresAt: string | null;
  /** Raw delivery status as stored ("sent" | "simulated" | "failed" | "disabled"); unknown values read as "desconocido". */
  deliveryStatus: InvitationDeliveryStatus | string | null;
  expired?: boolean;
  /** Always null in the users list (never rendered; the link only comes back from invite / reissue). */
  inviteUrl?: null;
};

export type BackOfficeUserRecord = {
  id: string;
  organizationId: string;
  email: string;
  phone?: string;
  fullName: string;
  status: "active" | "invited" | "disabled";
  mfaEnabled: boolean;
  lastLoginAt?: string;
  /** Present for invited users on the cierre API; null/absent otherwise. */
  pendingInvitation?: PendingInvitation | null;
};

export type InviteBackOfficeUserInput = {
  email: string;
  fullName: string;
  phone?: string;
  roleId: string;
  mfaRequired?: boolean;
};

export type InviteBackOfficeUserResponse = {
  user: BackOfficeUserRecord;
  invitation: InvitationResult;
};

// ---------------------------------------------------------------------------
// Public requests (no session, no demo fallback) go through publicRequest in api-client
// ---------------------------------------------------------------------------


/** Stable per-browser device id (same key LoginScreen uses). */
export function getDeviceId(): string {
  try {
    const existing = window.localStorage.getItem("hotelos.auth.deviceId");
    if (existing) return existing;
    const id = `dev_admin_web_${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem("hotelos.auth.deviceId", id);
    return id;
  } catch {
    return "dev_admin_web";
  }
}

// ---------------------------------------------------------------------------
// Password policy + client-side validation
// ---------------------------------------------------------------------------

/** Safe default while GET /auth/password-policy is loading or unreachable. */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireUppercase: true,
  requireDigit: true,
  requireSpecial: true
};

export function fetchPasswordPolicy(signal?: AbortSignal): Promise<PasswordPolicy> {
  return publicRequest<PasswordPolicy>("/auth/password-policy", { signal });
}

export type PasswordCheck = { key: string; label: string; ok: boolean };

/**
 * Evaluates a candidate password against the policy. The server enforces the
 * same rules (plus a common-password list) and answers 400; this only gives
 * the user live feedback before submitting.
 */
export function checkPassword(password: string, policy: PasswordPolicy): PasswordCheck[] {
  const checks: PasswordCheck[] = [
    { key: "length", label: `Al menos ${policy.minLength} caracteres`, ok: password.length >= policy.minLength }
  ];
  if (policy.requireUppercase) checks.push({ key: "upper", label: "Una letra mayúscula", ok: /[A-ZÁÉÍÓÚÜÑ]/.test(password) });
  if (policy.requireDigit) checks.push({ key: "digit", label: "Un número", ok: /\d/.test(password) });
  if (policy.requireSpecial) checks.push({ key: "special", label: "Un símbolo (p. ej. !, ?, #)", ok: /[^A-Za-z0-9\s]/.test(password) });
  return checks;
}

export function passwordMeetsPolicy(password: string, policy: PasswordPolicy): boolean {
  return checkPassword(password, policy).every((check) => check.ok);
}

// ---------------------------------------------------------------------------
// Invitations — public leg
// ---------------------------------------------------------------------------

/**
 * GET /auth/invitations/:token. Returns null on the generic 404 the API uses
 * for unknown / expired / used / revoked tokens; other failures throw.
 */
export async function fetchInvitation(token: string, signal?: AbortSignal): Promise<InvitationPreview | null> {
  try {
    return await publicRequest<InvitationPreview>(`/auth/invitations/${encodeURIComponent(token)}`, { signal });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** POST /auth/accept-invite → session (same shape as login). */
export function acceptInvitation(input: { token: string; password: string }): Promise<LoginResponse> {
  return publicRequest<LoginResponse>("/auth/accept-invite", {
    method: "POST",
    body: { token: input.token, password: input.password, deviceId: getDeviceId() }
  });
}

// ---------------------------------------------------------------------------
// Forgot / reset password — public leg
// ---------------------------------------------------------------------------

export type ForgotPasswordResponse = {
  message: string;
  /** Only present when the API runs with AUTH_EXPOSE_RESET_TOKEN=true (tests/demo). */
  _testToken?: string;
};

export function requestPasswordReset(email: string): Promise<ForgotPasswordResponse> {
  return publicRequest<ForgotPasswordResponse>("/auth/forgot-password", {
    method: "POST",
    body: { email }
  });
}

export function resetPassword(input: { token: string; newPassword: string }): Promise<{ userId: string }> {
  return publicRequest<{ userId: string }>("/auth/reset-password", {
    method: "POST",
    body: input
  });
}

// ---------------------------------------------------------------------------
// Authenticated legs
// ---------------------------------------------------------------------------

/**
 * POST /auth/change-password. The API revokes every session afterwards.
 *
 * Deliberately NOT routed through apiRequest: the service answers 401 for a
 * wrong current password, and apiRequest treats any 401 as an expired session
 * (clears storage, logs the user out). Here a 401 is surfaced as a form error
 * unless the body says the session itself is gone.
 */
export async function changePassword(input: { currentPassword: string; newPassword: string }): Promise<{ message: string }> {
  // keepSessionOn401: a wrong current password must read as a form error, not
  // as an expired session (apiRequest would otherwise log the user out).
  return apiRequest<{ message: string }>("/auth/change-password", { method: "POST", body: input, keepSessionOn401: true });
}

export function fetchEmailStatus(): Promise<EmailStatus> {
  return apiRequest<EmailStatus>("/notifications/email-status");
}

export async function fetchPropertyRoles(propertyId: string): Promise<PropertyRole[]> {
  const res = await apiRequest<unknown>(`/backoffice/properties/${propertyId}/roles`);
  return toArray<PropertyRole>(res);
}

export function inviteBackOfficeUser(
  propertyId: string,
  input: InviteBackOfficeUserInput
): Promise<InviteBackOfficeUserResponse> {
  return apiRequest<InviteBackOfficeUserResponse>(`/backoffice/properties/${propertyId}/users/invite`, {
    method: "POST",
    body: input
  });
}

export function reissueBackOfficeInvitation(propertyId: string, userId: string): Promise<InvitationResult> {
  return apiRequest<InvitationResult>(`/backoffice/properties/${propertyId}/users/${userId}/reissue-invite`, {
    method: "POST"
  });
}

// ---------------------------------------------------------------------------
// Helpers shared by the screens
// ---------------------------------------------------------------------------

/** Whether the stored session must rotate its password before using the app. */
export function sessionMustChangePassword(): boolean {
  const user = getUser() as SessionUser | null;
  return user?.mustChangePassword === true;
}

/** Human copy for a delivery status (never claims "enviado" unless it was). */
export function describeDelivery(delivery: InvitationDelivery | undefined, email?: string): {
  tone: "ok" | "warn" | "error";
  title: string;
  detail: string;
} {
  const to = email ? ` a ${email}` : "";
  switch (delivery?.status) {
    case "sent":
      return {
        tone: "ok",
        title: `Invitación enviada${to}`,
        detail: delivery.provider ? `Entregada al proveedor de email (${delivery.provider}).` : "Entregada al proveedor de email."
      };
    case "simulated":
      return {
        tone: "warn",
        title: "Email no configurado: copia el enlace",
        detail: "El servidor está en modo simulado y no ha enviado ningún email. Entrega el enlace de invitación por otro canal."
      };
    case "disabled":
      return {
        tone: "warn",
        title: "Email no configurado: copia el enlace",
        detail: "No hay proveedor de email saliente configurado. Entrega el enlace de invitación por otro canal."
      };
    case "failed":
      return {
        tone: "error",
        title: "No se pudo enviar el email",
        detail: delivery.errorMessage ? `Error del proveedor: ${delivery.errorMessage}. Copia el enlace y entrégalo por otro canal.` : "El proveedor de email rechazó el envío. Copia el enlace y entrégalo por otro canal."
      };
    default:
      return {
        tone: "warn",
        title: "Estado del envío desconocido",
        detail: "La API no informó del resultado del email. Copia el enlace por si acaso."
      };
  }
}

export function formatExpiry(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-ES", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** True when the invitation is past its expiry (server flag first, then the date). */
export function isInvitationExpired(invitation: PendingInvitation | null | undefined, now: Date = new Date()): boolean {
  if (!invitation) return false;
  if (typeof invitation.expired === "boolean") return invitation.expired;
  if (!invitation.expiresAt) return false;
  const expiresAt = new Date(invitation.expiresAt);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now.getTime();
}

/**
 * Human copy for the pending invitation of an invited user. Never claims the
 * email was sent unless deliveryStatus === "sent"; null when the API did not
 * expose the invitation (the screen then falls back to the bare status).
 */
export function describePendingInvitation(
  invitation: PendingInvitation | null | undefined,
  now: Date = new Date()
): { tone: "warn" | "error"; label: string; detail: string } | null {
  if (!invitation) return null;
  const expiry = formatExpiry(invitation.expiresAt);
  if (isInvitationExpired(invitation, now)) {
    return {
      tone: "error",
      label: "Caducada",
      detail: `La invitación caducó el ${expiry}. El enlace ya no sirve: reenvíala para generar uno nuevo.`
    };
  }
  const delivery =
    invitation.deliveryStatus === "sent"
      ? "Email entregado al proveedor."
      : invitation.deliveryStatus === "failed"
        ? "El email no se pudo enviar."
        : invitation.deliveryStatus === "simulated" || invitation.deliveryStatus === "disabled"
          ? "No se envió ningún email (servidor sin proveedor de correo)."
          : "Estado del email desconocido.";
  return {
    tone: "warn",
    label: `Invitación pendiente (caduca ${expiry})`,
    detail: `${delivery} Reenviar genera un enlace nuevo de un solo uso y anula el anterior.`
  };
}

export async function copyText(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
