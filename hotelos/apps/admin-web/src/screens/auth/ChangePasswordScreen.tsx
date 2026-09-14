// ChangePasswordScreen — forced (or voluntary) password rotation.
//
// Shown by auth/PublicAuthRoutes.tsx when the session must rotate its
// temporary password: either the stored user carries `mustChangePassword`
// (set by the API at login) or a request answered 403 with
// details.code = PASSWORD_CHANGE_REQUIRED (recorded by services/api-client.ts).
//
// POST /auth/change-password is on the API allowlist for such sessions. After
// a successful change the API revokes EVERY session of the user, so the screen
// clears the local session and sends them back to the login — there is no way
// to "continue" with the old token.

import { useEffect, useState, type FormEvent } from "react";
import { clearSession, getUser } from "../../services/auth-storage";
import { ApiError, clearPasswordChangeRequired } from "../../services/api-client";
import {
  changePassword,
  DEFAULT_PASSWORD_POLICY,
  fetchPasswordPolicy,
  passwordMeetsPolicy,
  type PasswordPolicy
} from "../../services/authApi";
import { AuthAlert, AuthShell, PasswordChecklist, PasswordField, goToLogin } from "../../auth/AuthShell";
import { logBreadcrumb } from "../../lib/breadcrumb";

export type ChangePasswordScreenProps = {
  /** true when the API demands the rotation (temp password); false for a voluntary change. */
  required?: boolean;
};

const REDIRECT_DELAY_MS = 2500;

export function ChangePasswordScreen({ required = true }: ChangePasswordScreenProps) {
  const user = getUser();
  const [policy, setPolicy] = useState<PasswordPolicy>(DEFAULT_PASSWORD_POLICY);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchPasswordPolicy(controller.signal)
      .then((loaded) => {
        if (!controller.signal.aborted) setPolicy(loaded);
      })
      .catch(() => {
        /* keep the documented defaults; the server re-validates anyway */
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(goToLogin, REDIRECT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [done]);

  const policyOk = passwordMeetsPolicy(password, policy);
  const confirmOk = confirm.length > 0 && confirm === password;
  const sameAsCurrent = current.length > 0 && current === password;
  const canSubmit = current.length > 0 && policyOk && confirmOk && !sameAsCurrent && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    logBreadcrumb("auth.change_password.attempt", "auth", { required });
    try {
      await changePassword({ currentPassword: current, newPassword: password });
      clearPasswordChangeRequired();
      // Every session was revoked server-side; the stored token is dead.
      clearSession();
      logBreadcrumb("auth.change_password.success", "auth");
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError("Demasiados intentos. Espera un minuto antes de volver a probar.");
      } else if (err instanceof ApiError) {
        setError(err.message || "No se pudo cambiar la contraseña.");
      } else {
        setError(err instanceof Error ? err.message : "Error de red. Inténtalo de nuevo.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleLogout() {
    clearPasswordChangeRequired();
    clearSession();
    goToLogin();
  }

  if (done) {
    return (
      <AuthShell
        title="Contraseña actualizada"
        footer={
          <button type="button" className="primary" onClick={goToLogin}>
            Iniciar sesión
          </button>
        }
      >
        <AuthAlert tone="success">
          Por seguridad hemos cerrado todas tus sesiones. Inicia sesión de nuevo con la contraseña nueva.
        </AuthAlert>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={required ? "Cambia tu contraseña temporal" : "Cambiar contraseña"}
      subtitle={
        required
          ? "Tu cuenta se creó con una contraseña temporal. Debes elegir una definitiva antes de seguir usando Anfitorio."
          : "Elige una contraseña nueva. Al guardarla se cerrarán todas tus sesiones."
      }
      footer={
        <button type="button" className="bo-button-link" onClick={handleLogout} disabled={submitting}>
          Cerrar sesión
        </button>
      }
    >
      {user?.email || user?.fullName ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-soft)" }}>
          Sesión de <strong style={{ color: "var(--ink)" }}>{user.email ?? user.fullName}</strong>
        </p>
      ) : null}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }} noValidate>
        <input type="email" name="username" autoComplete="username" value={user?.email ?? ""} readOnly hidden />
        <PasswordField label="Contraseña actual" value={current} onChange={setCurrent} autoComplete="current-password" disabled={submitting} autoFocus />
        <PasswordField label="Nueva contraseña" value={password} onChange={setPassword} autoComplete="new-password" disabled={submitting} />
        <PasswordChecklist password={password} policy={policy} />
        <PasswordField label="Repite la nueva contraseña" value={confirm} onChange={setConfirm} autoComplete="new-password" disabled={submitting} />
        {sameAsCurrent ? <AuthAlert tone="warn">La nueva contraseña debe ser distinta de la actual.</AuthAlert> : null}
        {confirm && !confirmOk ? <AuthAlert tone="warn">Las contraseñas no coinciden.</AuthAlert> : null}
        {error ? <AuthAlert tone="error">{error}</AuthAlert> : null}
        <button type="submit" className="primary" disabled={!canSubmit} style={{ marginTop: "var(--space-2)" }}>
          {submitting ? "Guardando…" : "Guardar contraseña"}
        </button>
      </form>
    </AuthShell>
  );
}

export default ChangePasswordScreen;
