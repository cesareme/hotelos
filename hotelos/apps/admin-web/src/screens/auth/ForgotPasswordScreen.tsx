// ForgotPasswordScreen — requests a password-reset link.
//
// Anti-enumeration: the API always answers 200 with the same neutral message,
// so the copy here is deliberately honest and vague ("si existe una cuenta…").
// Whether the email really goes out depends on the server's outbound email
// provider; when it runs with AUTH_EXPOSE_RESET_TOKEN=true (tests / demo) the
// response carries `_testToken` and we show the /reset-password link so the
// flow can be exercised without a mailbox. Never shown otherwise.

//
// Cocoa 22: the form controls are CocoaField + CocoaInput and the actions
// CocoaButton (style={} is layout only). The frame (AuthShell / AuthAlert /
// CopyLinkRow of auth/AuthShell.tsx) is shared with the other public screens
// and migrates with them.

import { useState, type FormEvent } from "react";
import { ApiError } from "../../services/api-client";
import { copyText, requestPasswordReset } from "../../services/authApi";
import { AuthAlert, AuthShell, CopyLinkRow, RESET_PASSWORD_PATH_FOR_LINKS } from "../../auth/AuthShell";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaField } from "../../components/cocoa/CocoaField";
import { CocoaInput } from "../../components/cocoa/CocoaInput";

type ForgotPasswordScreenProps = {
  onNavigate?: (screen: string) => void;
};

const NEUTRAL_MESSAGE =
  "Si existe una cuenta con ese email, recibirás un enlace para restablecer la contraseña. Caduca a los 15 minutos. Si no llega, revisa la carpeta de spam o pide a tu administrador que te reenvíe el acceso.";

function buildResetLink(token: string): string {
  return `${window.location.origin}${RESET_PASSWORD_PATH_FOR_LINKS}?token=${encodeURIComponent(token)}`;
}

export function ForgotPasswordScreen(props: ForgotPasswordScreenProps) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [testLink, setTestLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      // Same neutral outcome whatever the backend decided (anti-enumeration);
      // only rate limiting and network errors are surfaced.
      const response = await requestPasswordReset(email.trim());
      setTestLink(response._testToken ? buildResetLink(response._testToken) : null);
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError("Demasiadas solicitudes. Espera un minuto antes de volver a probar.");
      } else if (err instanceof ApiError && err.status === 400) {
        // Shape validation only (malformed email): safe to show, reveals nothing.
        setError(err.message || "Indica un email válido.");
      } else if (err instanceof ApiError) {
        // Any other 4xx/5xx must not reveal whether the account exists.
        setSubmitted(true);
      } else {
        setError(err instanceof Error ? err.message : "Error de red. Inténtalo de nuevo.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!testLink) return;
    if (await copyText(testLink)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }

  return (
    <AuthShell
      title="Recuperar contraseña"
      subtitle="Indica el email de tu cuenta y te enviaremos un enlace para elegir una contraseña nueva."
      footer={
        <CocoaButton variant="plain" tone="accent" onClick={() => props.onNavigate?.("LoginScreen")}>
          Volver a iniciar sesión
        </CocoaButton>
      }
    >
      {submitted ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-4)" }}>
          <AuthAlert tone="info">{NEUTRAL_MESSAGE}</AuthAlert>
          {testLink ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-3)" }}>
              <AuthAlert tone="warn">
                Modo pruebas (AUTH_EXPOSE_RESET_TOKEN): el servidor ha devuelto el enlace en vez de enviarlo por email.
              </AuthAlert>
              <CopyLinkRow label="Enlace de restablecimiento" value={testLink} copied={copied} onCopy={() => void handleCopy()} />
            </div>
          ) : null}
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-4)" }} noValidate>
          <CocoaField label="Correo electrónico" htmlFor="forgot-email" required>
            <CocoaInput
              id="forgot-email"
              type="email"
              inputMode="email"
              autoComplete="username"
              size="large"
              autoFocus
              value={email}
              onChange={setEmail}
              disabled={submitting}
              placeholder="tu@hotel.com"
            />
          </CocoaField>
          {error ? <AuthAlert tone="error">{error}</AuthAlert> : null}
          <CocoaButton type="submit" variant="filled" tone="accent" size="large" loading={submitting} disabled={!email.trim()} style={{ width: "100%" }}>
            {submitting ? "Enviando…" : "Enviar enlace de recuperación"}
          </CocoaButton>
        </form>
      )}
    </AuthShell>
  );
}

export default ForgotPasswordScreen;
