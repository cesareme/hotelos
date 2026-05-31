import { useState, type FormEvent } from "react";
import { setSession, type AuthUser } from "../../services/auth-storage";
import { apiBase } from "../../services/api-client";
import { logBreadcrumb } from "../../lib/breadcrumb";

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

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-6)",
        background: "var(--canvas, var(--surface-1))"
      }}
    >
      <div
        className="bo-card"
        style={{
          width: "100%",
          maxWidth: 420,
          padding: "var(--space-8)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
          background: "var(--surface-1)",
          borderRadius: "var(--radius-md)"
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <h1 style={{ margin: 0, color: "var(--ink)", fontSize: 22 }}>HotelOS</h1>
          <p style={{ margin: 0, color: "var(--ink-soft)" }}>Inicia sesión para continuar</p>
        </div>

        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
          noValidate
        >
          <label className="bo-form-field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              required
              autoFocus={!email}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={submitting}
            />
          </label>

          <label className="bo-form-field">
            <span>Contraseña</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              autoFocus={Boolean(email)}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
            />
          </label>

          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              color: "var(--ink-soft)",
              fontSize: 14
            }}
          >
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              disabled={submitting}
            />
            <span>Recordarme</span>
          </label>

          {error ? (
            <div
              role="alert"
              style={{
                padding: "var(--space-3) var(--space-4)",
                borderRadius: "var(--radius-sm)",
                background: "var(--danger-soft, #fdecec)",
                color: "var(--danger-strong, #8a1f1f)",
                fontSize: 14
              }}
            >
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            className="primary"
            disabled={submitting || !email.trim() || !password}
            style={{ marginTop: "var(--space-2)" }}
          >
            {submitting ? "Iniciando sesión…" : "Iniciar sesión"}
          </button>
        </form>

        <div style={{ display: "flex", justifyContent: "center" }}>
          <button
            type="button"
            className="bo-button-link"
            disabled={!canForgot || submitting}
            onClick={() => {
              if (canForgot) props.onNavigate?.("ForgotPasswordScreen");
            }}
            title={canForgot ? "Recuperar contraseña" : "Recuperación no disponible"}
          >
            ¿Olvidaste tu contraseña?
          </button>
        </div>
      </div>
    </div>
  );
}

export default LoginScreen;
