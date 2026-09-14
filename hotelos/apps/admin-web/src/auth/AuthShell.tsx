// Shared primitives for the public auth screens (accept invite, reset and
// change password). Same visual language as LoginScreen: a centred bo-card on
// the canvas, bo-form-field inputs, inline alerts. Kept out of screens/ so the
// discoverability check does not count it as an orphan screen.

import type { ReactNode } from "react";
import { checkPassword, type PasswordPolicy } from "../services/authApi";

export function AuthShell({
  title,
  subtitle,
  children,
  footer
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
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
          maxWidth: 440,
          padding: "var(--space-8)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
          background: "var(--surface-1)",
          borderRadius: "var(--radius-md)"
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <p style={{ margin: 0, color: "var(--ink-soft)", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Anfitorio
          </p>
          <h1 style={{ margin: 0, color: "var(--ink)", fontSize: 22 }}>{title}</h1>
          {subtitle ? <p style={{ margin: 0, color: "var(--ink-soft)" }}>{subtitle}</p> : null}
        </div>
        {children}
        {footer ? <div style={{ display: "flex", justifyContent: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>{footer}</div> : null}
      </div>
    </div>
  );
}

export type AuthAlertTone = "error" | "success" | "info" | "warn";

const ALERT_STYLE: Record<AuthAlertTone, { background: string; color: string }> = {
  error: { background: "var(--danger-soft, #fdecec)", color: "var(--danger-strong, #8a1f1f)" },
  success: { background: "var(--success-soft, #e6f4ea)", color: "var(--success-strong, #1e5e34)" },
  info: { background: "var(--accent-soft)", color: "var(--accent-strong)" },
  warn: { background: "var(--warning-soft, #fff4d6)", color: "var(--warning-strong, #7a4b00)" }
};

export function AuthAlert({ tone, children }: { tone: AuthAlertTone; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      style={{
        padding: "var(--space-3) var(--space-4)",
        borderRadius: "var(--radius-sm)",
        fontSize: 14,
        lineHeight: 1.45,
        ...ALERT_STYLE[tone]
      }}
    >
      {children}
    </div>
  );
}

/** Live checklist of the password policy (mirrors the server rules). */
export function PasswordChecklist({ password, policy }: { password: string; policy: PasswordPolicy }) {
  const checks = checkPassword(password, policy);
  return (
    <ul
      aria-label="Requisitos de la contraseña"
      style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}
    >
      {checks.map((check) => (
        <li
          key={check.key}
          style={{ display: "flex", alignItems: "center", gap: 8, color: check.ok ? "var(--success-strong, #1e5e34)" : "var(--ink-soft)" }}
        >
          <span aria-hidden="true" style={{ width: 14, display: "inline-block", textAlign: "center" }}>
            {check.ok ? "✓" : "·"}
          </span>
          <span>{check.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  disabled,
  autoFocus
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label className="bo-form-field">
      <span>{label}</span>
      <input
        type="password"
        autoComplete={autoComplete}
        required
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </label>
  );
}

/** Copyable read-only value (invite / reset links) for the public screens. */
export function CopyLinkRow({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="bo-form-field" style={{ margin: 0 }}>
      <span>{label}</span>
      <div style={{ display: "flex", gap: 8 }}>
        <input readOnly value={value} onFocus={(event) => event.currentTarget.select()} style={{ flex: 1, minWidth: 0 }} />
        <button type="button" onClick={onCopy}>{copied ? "Copiado" : "Copiar"}</button>
      </div>
    </div>
  );
}

/** Full-page navigation helpers (the shell has no router; a reload is the safe reset). */
export function goToLogin(): void {
  window.location.replace("/");
}

/**
 * Path of the reset screen, duplicated here (not imported from
 * PublicAuthRoutes) so screens never import the router module that imports
 * them back. Must match RESET_PASSWORD_PATH in auth/PublicAuthRoutes.tsx.
 */
export const RESET_PASSWORD_PATH_FOR_LINKS = "/reset-password";
