// LoginScreen — public sign-in (Cocoa 22, COCOA-22.md §3.5/§3.8: elevated
// card on the canvas, CocoaPageHeader, CocoaField + CocoaInput, filled
// accent action; every colour comes from the tokens, style={} is layout only).
// The auth logic (fetch, lockout copy, remembered email) is untouched.

import { useState, type FormEvent } from "react";
import { setSession, type AuthUser } from "../../services/auth-storage";
import { apiBase } from "../../services/api-client";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaField } from "../../components/cocoa/CocoaField";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaState } from "../../components/cocoa/CocoaState";
import { CocoaSwitch } from "../../components/cocoa/CocoaSwitch";
import { AUTH_EYEBROW } from "../../auth/AuthShell";

type LoginResponse = {
  token: string;
  sessionId?: string;
  user: AuthUser;
};

type LoginScreenProps = {
  onNavigate?: (screen: string) => void;
};

const REMEMBER_KEY = "hotelos.auth.rememberEmail";

function getRememberedEmail(): string {
  try {
    return window.localStorage.getItem(REMEMBER_KEY) ?? "";
  } catch {
    return "";
  }
}

function persistRememberedEmail(email: string, remember: boolean): void {
  try {
    if (remember) window.localStorage.setItem(REMEMBER_KEY, email);
    else window.localStorage.removeItem(REMEMBER_KEY);
  } catch {
    /* ignore */
  }
}

function getDeviceId(): string {
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

export function LoginScreen(props: LoginScreenProps) {
  const initialEmail = getRememberedEmail();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(Boolean(initialEmail));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    // PII-safe: no incluimos el email del usuario en el breadcrumb. Solo
    // marcamos el intento para reconstruir la secuencia previa al error.
    logBreadcrumb("auth.login.attempt", "auth", { remember });
    try {
      const response = await fetch(`${apiBase()}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password,
          deviceId: getDeviceId()
        })
      });

      if (response.status === 401) {
        setError("Email o contraseña incorrectos.");
        return;
      }
      if (response.status === 403) {
        const text = await response.text();
        let parsed: { message?: string } = {};
        try {
          parsed = JSON.parse(text) as { message?: string };
        } catch {
          /* keep parsed empty */
        }
        const msg = parsed.message ?? text;
        // Lockout error from backend includes minutes. Surface verbatim because
        // the API already includes the remaining time (e.g. "Reintenta en 15 min").
        const matched = /(\d+)\s*min/i.exec(msg);
        if (matched) {
          setError(`Cuenta bloqueada temporalmente. Reintenta en ${matched[1]} minutos.`);
        } else {
          setError(msg || "Tu cuenta no puede iniciar sesión en este momento.");
        }
        return;
      }
      if (!response.ok) {
        const text = await response.text();
        try {
          const parsed = JSON.parse(text) as { message?: string };
          setError(parsed.message ?? text ?? "No se pudo iniciar sesión.");
        } catch {
          setError(text || "No se pudo iniciar sesión.");
        }
        return;
      }

      const data = (await response.json()) as LoginResponse;
      persistRememberedEmail(email.trim(), remember);
      const user: AuthUser = { ...data.user, email: email.trim() };
      setSession(data.token, user);
      logBreadcrumb("auth.login.success", "auth");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error de red. Inténtalo de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

  const canForgot = typeof props.onNavigate === "function";

  // The body already paints the canvas (--cocoa-background-window) in Inter:
  // the page only centres the card; gutter --cocoa-content-padding (24 / 16 < 600, §5.1) + safe-area.
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--cocoa-content-padding)",
        paddingBottom: "max(var(--cocoa-content-padding), env(safe-area-inset-bottom))",
        boxSizing: "border-box"
      }}
    >
      <CocoaCard
        variant="elevated"
        padding="lg"
        role="region"
        aria-label="Inicio de sesión"
        style={{ width: "100%", maxWidth: 420, display: "flex", flexDirection: "column", gap: "var(--cocoa-space-5)" }}
      >
        <CocoaPageHeader eyebrow={AUTH_EYEBROW} title="Inicia sesión" subtitle="Introduce tu correo y tu contraseña para continuar." />

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-4)" }} noValidate>
          <CocoaField label="Correo electrónico" htmlFor="login-email" required>
            <CocoaInput
              id="login-email"
              type="email"
              inputMode="email"
              autoComplete="username"
              size="large"
              autoFocus={!email}
              value={email}
              onChange={setEmail}
              disabled={submitting}
              placeholder="tu@hotel.com"
            />
          </CocoaField>

          <CocoaField label="Contraseña" htmlFor="login-password" required>
            <CocoaInput
              id="login-password"
              type="password"
              autoComplete="current-password"
              size="large"
              autoFocus={Boolean(email)}
              value={password}
              onChange={setPassword}
              disabled={submitting}
            />
          </CocoaField>

          <CocoaSwitch size="small" checked={remember} onChange={setRemember} disabled={submitting} label="Recordarme" />

          {error ? <CocoaState kind="error" inline role="alert" title="No se pudo iniciar sesión" message={error} /> : null}

          <CocoaButton
            type="submit"
            variant="filled"
            tone="accent"
            size="large"
            loading={submitting}
            disabled={!email.trim() || !password}
            style={{ width: "100%", marginTop: "var(--cocoa-space-1)" }}
          >
            {submitting ? "Iniciando sesión…" : "Iniciar sesión"}
          </CocoaButton>
        </form>

        <div style={{ display: "flex", justifyContent: "center" }}>
          <CocoaButton
            variant="plain"
            tone="accent"
            disabled={!canForgot || submitting}
            onClick={() => {
              if (canForgot) props.onNavigate?.("ForgotPasswordScreen");
            }}
            title={canForgot ? "Recuperar contraseña" : "Recuperación no disponible"}
          >
            ¿Olvidaste tu contraseña?
          </CocoaButton>
        </div>
      </CocoaCard>
    </div>
  );
}

export default LoginScreen;
