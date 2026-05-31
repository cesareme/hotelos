import { useState, type FormEvent } from "react";
import { apiBase } from "../../services/api-client";

type ForgotPasswordScreenProps = {
  onNavigate?: (screen: string) => void;
};

const NEUTRAL_MESSAGE =
  "Si existe una cuenta con ese email, recibirás un enlace de recuperación.";

export function ForgotPasswordScreen(props: ForgotPasswordScreenProps) {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      // We always surface the same neutral message regardless of backend outcome
      // (anti-enumeration). Only network/throwable errors surface to the user.
      await fetch(`${apiBase()}/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() })
      });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error de red. Inténtalo de nuevo.");
    } finally {
      setSubmitting(false);
    }
  }

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
          <h1 style={{ margin: 0, color: "var(--ink)", fontSize: 22 }}>
            Recuperar contraseña
          </h1>
          <p style={{ margin: 0, color: "var(--ink-soft)" }}>
            Te enviaremos un enlace para restablecer tu contraseña.
          </p>
        </div>

        {submitted ? (
          <div
            role="status"
            style={{
              padding: "var(--space-4)",
              borderRadius: "var(--radius-sm)",
              background: "var(--accent-soft)",
              color: "var(--accent-strong)",
              fontSize: 14
            }}
          >
            {NEUTRAL_MESSAGE}
          </div>
        ) : (
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
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={submitting}
              />
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
              disabled={submitting || !email.trim()}
            >
              {submitting ? "Enviando…" : "Enviar enlace de recuperación"}
            </button>
          </form>
        )}

        <div style={{ display: "flex", justifyContent: "center" }}>
          <button
            type="button"
            className="bo-button-link"
            onClick={() => props.onNavigate?.("LoginScreen")}
          >
            Volver a iniciar sesión
          </button>
        </div>
      </div>
    </div>
  );
}

export default ForgotPasswordScreen;
