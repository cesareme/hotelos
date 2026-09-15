// ResetPasswordScreen — consumes the link from "¿Olvidaste tu contraseña?"
// (/reset-password?token=…). Mounted by auth/PublicAuthRoutes.tsx before the
// AuthGate. POST /auth/reset-password validates the token (15 min TTL, single
// use) and the password policy server-side; on success every session of the
// user is revoked, so we clear local storage and send them to the login.
//
// Cocoa 22 (COCOA-22.md §4 «otro», PlantillaBase over the AuthShell frame):
// CocoaPageHeader inside the elevated card, CocoaField + CocoaInput with the
// mismatch as the field's error, CocoaCallout alerts, CocoaButton actions.
// Logic untouched.

import { useEffect, useState, type FormEvent } from "react";
import { clearSession } from "../../services/auth-storage";
import { ApiError } from "../../services/api-client";
import {
  DEFAULT_PASSWORD_POLICY,
  fetchPasswordPolicy,
  passwordMeetsPolicy,
  resetPassword,
  type PasswordPolicy
} from "../../services/authApi";
import { AUTH_EYEBROW, AuthAlert, AuthShell, PasswordChecklist, PasswordField, goToLogin } from "../../auth/AuthShell";
import { CocoaButton, CocoaPageHeader } from "../../components/cocoa";
import { ACTIONS } from "../../content/actions";
import { logBreadcrumb } from "../../lib/breadcrumb";

export type ResetPasswordScreenProps = {
  token: string | null;
};

const MISSING_TOKEN_COPY =
  "Este enlace no es válido. Vuelve a solicitar la recuperación de contraseña desde la pantalla de inicio de sesión.";

export function ResetPasswordScreen({ token }: ResetPasswordScreenProps) {
  const [policy, setPolicy] = useState<PasswordPolicy>(DEFAULT_PASSWORD_POLICY);
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

  const policyOk = passwordMeetsPolicy(password, policy);
  const confirmOk = confirm.length > 0 && confirm === password;
  const canSubmit = Boolean(token) && policyOk && confirmOk && !submitting;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !canSubmit) return;
    setError(null);
    setSubmitting(true);
    logBreadcrumb("auth.reset_password.attempt", "auth");
    try {
      await resetPassword({ token, newPassword: password });
      // The API revoked every session of this user: drop the local one too.
      clearSession();
      logBreadcrumb("auth.reset_password.success", "auth");
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError("Demasiados intentos. Espera un minuto antes de volver a probar.");
      } else if (err instanceof ApiError && (err.status === 400 || err.status === 404)) {
        // 400 carries the server reason: token inválido / usado / expirado, or
        // the password policy. Surface it verbatim (already in Spanish).
        setError(err.message || MISSING_TOKEN_COPY);
      } else {
        setError(err instanceof Error ? err.message : "Error de red. Inténtalo de nuevo.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <AuthShell
        label="Enlace no válido"
        footer={
          <CocoaButton variant="plain" tone="accent" onClick={goToLogin}>
            Ir a iniciar sesión
          </CocoaButton>
        }
      >
        <CocoaPageHeader eyebrow={AUTH_EYEBROW} title="Enlace no válido" />
        <AuthAlert tone="error">{MISSING_TOKEN_COPY}</AuthAlert>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell
        label="Contraseña restablecida"
        footer={
          <CocoaButton variant="filled" tone="accent" onClick={goToLogin}>
            {ACTIONS.signIn}
          </CocoaButton>
        }
      >
        <CocoaPageHeader eyebrow={AUTH_EYEBROW} title="Contraseña restablecida" />
        <AuthAlert tone="success">
          Tu contraseña se ha actualizado y hemos cerrado las sesiones anteriores por seguridad. Ya puedes iniciar sesión con la nueva
          contraseña.
        </AuthAlert>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      label="Nueva contraseña"
      footer={
        <CocoaButton variant="plain" tone="accent" onClick={goToLogin} disabled={submitting}>
          Volver a iniciar sesión
        </CocoaButton>
      }
    >
      <CocoaPageHeader
        eyebrow={AUTH_EYEBROW}
        title="Nueva contraseña"
        subtitle="Elige una contraseña nueva para tu cuenta. El enlace caduca a los 15 minutos y solo se puede usar una vez."
      />
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-4)" }} noValidate>
        <PasswordField id="reset-password" label="Nueva contraseña" value={password} onChange={setPassword} autoComplete="new-password" disabled={submitting} autoFocus />
        <PasswordChecklist password={password} policy={policy} />
        <PasswordField
          id="reset-confirm"
          label="Repite la contraseña"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          disabled={submitting}
          error={confirm && !confirmOk ? "Las contraseñas no coinciden." : undefined}
        />
        {error ? <AuthAlert tone="error">{error}</AuthAlert> : null}
        <CocoaButton
          type="submit"
          variant="filled"
          tone="accent"
          size="large"
          loading={submitting}
          disabled={!canSubmit}
          style={{ width: "100%", marginTop: "var(--cocoa-space-1)" }}
        >
          {submitting ? "Guardando…" : "Guardar contraseña"}
        </CocoaButton>
      </form>
    </AuthShell>
  );
}

export default ResetPasswordScreen;
