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
//
// Cocoa 22 (COCOA-22.md §4 «otro», PlantillaBase over the AuthShell frame):
// CocoaPageHeader inside the elevated card, invitation facts in a
// `c22-section__list`, CocoaField + CocoaInput (mismatch as the field's
// error), CocoaCallout alerts, CocoaButton actions. The auth logic is untouched.

import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { clearSession, setSession } from "../../services/auth-storage";
import { ApiError, clearPasswordChangeRequired } from "../../services/api-client";
import {
  acceptInvitation,
  DEFAULT_PASSWORD_POLICY,
  fetchInvitation,
  fetchPasswordPolicy,
  passwordMeetsPolicy,
  type InvitationPreview,
  type PasswordPolicy
} from "../../services/authApi";
import { AUTH_EYEBROW, AuthAlert, AuthShell, HiddenUsername, PasswordChecklist, PasswordField, goToLogin } from "../../auth/AuthShell";
import { CocoaButton, CocoaPageHeader, CocoaState } from "../../components/cocoa";
import { FIELD_LABELS } from "../../content/actions";
import { dateTime } from "../../lib/format";
import { logBreadcrumb } from "../../lib/breadcrumb";

type Phase = "loading" | "invalid" | "ready" | "done";

export type AcceptInviteScreenProps = {
  /** Invitation token from the URL (?token=…); null when missing. */
  token: string | null;
};

const INVALID_COPY =
  "Esta invitación no es válida, ya se ha utilizado o ha caducado. Pide a la persona que te invitó que la reenvíe desde Anfitorio.";

// A long email must not push the row wider than the card (the list paints
// values nowrap): clip it and keep the full value in the tooltip.
const valueStyle: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" };

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
      <AuthShell label="Comprobando tu invitación">
        <CocoaPageHeader eyebrow={AUTH_EYEBROW} title="Comprobando tu invitación…" subtitle="Un momento." />
        <CocoaState kind="loading" />
      </AuthShell>
    );
  }

  if (phase === "invalid") {
    return (
      <AuthShell
        label="Invitación no válida"
        footer={
          <CocoaButton variant="plain" tone="accent" onClick={goToLogin}>
            Ir a iniciar sesión
          </CocoaButton>
        }
      >
        <CocoaPageHeader eyebrow={AUTH_EYEBROW} title="Invitación no válida" />
        <AuthAlert tone="error">{loadError ?? INVALID_COPY}</AuthAlert>
      </AuthShell>
    );
  }

  if (phase === "done") {
    return (
      <AuthShell label="Cuenta activada">
        <CocoaPageHeader eyebrow={AUTH_EYEBROW} title="Cuenta activada" />
        <AuthAlert tone="success">Tu cuenta está lista. Entrando en Anfitorio…</AuthAlert>
      </AuthShell>
    );
  }

  const scope = [invitation?.organizationName, invitation?.propertyName].filter(Boolean).join(" · ");
  // The greeting lives in the subtitle: the header title is one line on
  // desktop and a long name would be clipped there.
  const greeting = invitation?.fullName ? `Hola, ${invitation.fullName}. ` : "";
  const role = invitation?.roleName ? ` con el rol ${invitation.roleName}` : "";
  const subtitle = `${greeting}Te han invitado a ${scope || "Anfitorio"}${role}. Elige una contraseña para activar tu cuenta.`;

  return (
    <AuthShell
      label="Crea tu contraseña"
      footer={
        <CocoaButton variant="plain" tone="accent" onClick={goToLogin} disabled={submitting}>
          Ya tengo cuenta · iniciar sesión
        </CocoaButton>
      }
    >
      <CocoaPageHeader eyebrow={AUTH_EYEBROW} title="Crea tu contraseña" subtitle={subtitle} />

      <ul className="c22-section__list" aria-label="Datos de la invitación">
        <li>
          <span>{FIELD_LABELS.email}</span>
          <strong style={valueStyle} title={invitation?.email}>
            {invitation?.email}
          </strong>
        </li>
        <li>
          <span>Caduca</span>
          <strong>{dateTime(invitation?.expiresAt, { style: "medium" })}</strong>
        </li>
      </ul>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-4)" }} noValidate>
        {/* Hidden username so password managers store the right login. */}
        <HiddenUsername email={invitation?.email ?? ""} />
        <PasswordField id="invite-password" label="Nueva contraseña" value={password} onChange={setPassword} autoComplete="new-password" disabled={submitting} autoFocus />
        <PasswordChecklist password={password} policy={policy} />
        <PasswordField
          id="invite-confirm"
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
          {submitting ? "Activando cuenta…" : "Activar cuenta y entrar"}
        </CocoaButton>
      </form>
    </AuthShell>
  );
}

export default AcceptInviteScreen;
