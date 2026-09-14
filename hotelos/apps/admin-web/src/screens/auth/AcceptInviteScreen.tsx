// AcceptInviteScreen — public leg of the staff invitation (Tanda 3 · CFG-P1-6).
//
// Reached at /accept-invite?token=… (mounted by auth/PublicAuthRoutes.tsx
// BEFORE the AuthGate, so it renders even when another session is stored).
//
//   1. GET /auth/invitations/:token → who is invited (email, organización,
//      propiedad, rol) and until when. The API answers the same generic 404
//      for unknown / expired / used / revoked tokens → "invitación no válida".
//   2. Password + confirmation validated live against GET /auth/password-policy
//      (the server re-validates and answers 400 with its own message).
//   3. POST /auth/accept-invite → LoginResult. Any previous session is cleared
//      first, then setSession() with the new one and a full reload to "/" (the
//      shell reads the active property at module-evaluation time).

import { useEffect, useState, type FormEvent } from "react";
import { clearSession, setSession } from "../../services/auth-storage";
import { ApiError, clearPasswordChangeRequired } from "../../services/api-client";
import {
  acceptInvitation,
  DEFAULT_PASSWORD_POLICY,
  fetchInvitation,
  fetchPasswordPolicy,
  formatExpiry,
  passwordMeetsPolicy,
  type InvitationPreview,
  type PasswordPolicy
} from "../../services/authApi";
import { AuthAlert, AuthShell, PasswordChecklist, PasswordField, goToLogin } from "../../auth/AuthShell";
import { logBreadcrumb } from "../../lib/breadcrumb";

type Phase = "loading" | "invalid" | "ready" | "done";

export type AcceptInviteScreenProps = {
  /** Invitation token from the URL (?token=…); null when missing. */
  token: string | null;
};

const INVALID_COPY =
  "Esta invitación no es válida, ya se ha utilizado o ha caducado. Pide a la persona que te invitó que la reenvíe desde Anfitorio.";

export function AcceptInviteScreen({ token }: AcceptInviteScreenProps) {
  const [phase, setPhase] = useState<Phase>(token ? "loading" : "invalid");
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [policy, setPolicy] = useState<PasswordPolicy>(DEFAULT_PASSWORD_POLICY);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setPhase("loading");
    setLoadError(null);
    Promise.all([
      fetchInvitation(token, controller.signal),
      // Policy failure is not fatal: fall back to the documented defaults.
      fetchPasswordPolicy(controller.signal).catch(() => DEFAULT_PASSWORD_POLICY)
    ])
      .then(([preview, loadedPolicy]) => {
        if (controller.signal.aborted) return;
        setPolicy(loadedPolicy);
        if (!preview) {
          setPhase("invalid");
          return;
        }
        setInvitation(preview);
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 429) {
          setLoadError("Demasiados intentos. Espera un minuto y recarga la página.");
        } else {
          setLoadError(err instanceof Error ? err.message : "No se pudo comprobar la invitación.");
        }
        setPhase("invalid");
      });
    return () => controller.abort();
  }, [token]);

  const policyOk = passwordMeetsPolicy(password, policy);
  const confirmOk = confirm.length > 0 && confirm === password;
  const canSubmit = phase === "ready" && policyOk && confirmOk && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !canSubmit) return;
    setError(null);
    setSubmitting(true);
    logBreadcrumb("auth.accept_invite.attempt", "auth");
    try {
      // The invited person may be sitting on someone else's session in this
      // browser: drop it before the new one is stored.
      clearSession();
      clearPasswordChangeRequired();
      const result = await acceptInvitation({ token, password });
      setSession(result.token, { ...result.user, email: invitation?.email ?? result.user.email });
      logBreadcrumb("auth.accept_invite.success", "auth");
      setPhase("done");
      goToLogin();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 404) {
          setPhase("invalid");
        } else if (err.status === 429) {
          setError("Demasiados intentos. Espera un minuto antes de volver a probar.");
        } else {
          setError(err.message || "No se pudo completar el alta.");
        }
      } else {
        setError(err instanceof Error ? err.message : "Error de red. Inténtalo de nuevo.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "loading") {
    return (
      <AuthShell title="Comprobando tu invitación…">
        <p style={{ margin: 0, color: "var(--ink-soft)" }}>Un momento.</p>
      </AuthShell>
    );
  }

  if (phase === "invalid") {
    return (
      <AuthShell
        title="Invitación no válida"
        footer={
          <button type="button" className="bo-button-link" onClick={goToLogin}>
            Ir a iniciar sesión
          </button>
        }
      >
        <AuthAlert tone="error">{loadError ?? INVALID_COPY}</AuthAlert>
      </AuthShell>
    );
  }

  if (phase === "done") {
    return (
      <AuthShell title="Cuenta activada">
        <AuthAlert tone="success">Tu cuenta está lista. Entrando en Anfitorio…</AuthAlert>
      </AuthShell>
    );
  }

  const scope = [invitation?.organizationName, invitation?.propertyName].filter(Boolean).join(" · ");

  return (
    <AuthShell
      title={invitation?.fullName ? `Hola, ${invitation.fullName}` : "Crea tu contraseña"}
      subtitle={
        <>
          Te han invitado a <strong>{scope || "Anfitorio"}</strong>
          {invitation?.roleName ? <> con el rol <strong>{invitation.roleName}</strong></> : null}. Elige una contraseña para
          activar tu cuenta.
        </>
      }
      footer={
        <button type="button" className="bo-button-link" onClick={goToLogin} disabled={submitting}>
          Ya tengo cuenta · iniciar sesión
        </button>
      }
    >
      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 13 }}>
        <dt style={{ color: "var(--ink-soft)" }}>Email</dt>
        <dd style={{ margin: 0, color: "var(--ink)" }}>{invitation?.email}</dd>
        <dt style={{ color: "var(--ink-soft)" }}>Caduca</dt>
        <dd style={{ margin: 0, color: "var(--ink)" }}>{formatExpiry(invitation?.expiresAt)}</dd>
      </dl>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }} noValidate>
        {/* Hidden username so password managers store the right login. */}
        <input type="email" name="username" autoComplete="username" value={invitation?.email ?? ""} readOnly hidden />
        <PasswordField label="Nueva contraseña" value={password} onChange={setPassword} autoComplete="new-password" disabled={submitting} autoFocus />
        <PasswordChecklist password={password} policy={policy} />
        <PasswordField label="Repite la contraseña" value={confirm} onChange={setConfirm} autoComplete="new-password" disabled={submitting} />
        {confirm && !confirmOk ? <AuthAlert tone="warn">Las contraseñas no coinciden.</AuthAlert> : null}
        {error ? <AuthAlert tone="error">{error}</AuthAlert> : null}
        <button type="submit" className="primary" disabled={!canSubmit} style={{ marginTop: "var(--space-2)" }}>
          {submitting ? "Activando cuenta…" : "Activar cuenta y entrar"}
        </button>
      </form>
    </AuthShell>
  );
}

export default AcceptInviteScreen;
