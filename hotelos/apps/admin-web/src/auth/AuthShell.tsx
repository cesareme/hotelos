// AuthShell — frame and form helpers shared by the public auth screens
// (accept invite, reset, change and forgot password). Cocoa 22 (COCOA-22.md
// §3.5 elevated card, §3.8 form grammar, §3.10 states; model:
// screens/auth/LoginScreen.tsx): the body already paints the canvas
// (--cocoa-background-window) in Inter, so the frame only centres an elevated
// CocoaCard — gutter `--cocoa-content-padding` like main.cocoa-content (24 px,
// 16 px below 600, §5.1) plus the safe-area — and lends the field, checklist,
// alert and copy-row helpers. Every colour comes from the tokens; style={} is
// layout only. Each screen paints its own <CocoaPageHeader eyebrow={AUTH_EYEBROW} …/>
// as the first child of the card (the contract reads the page header from
// the screen file, rule 7). Kept out of screens/ so the discoverability check
// does not count it as an orphan screen.

import type { ComponentType, CSSProperties, ReactNode } from "react";
import { checkPassword, type PasswordPolicy } from "../services/authApi";
import { CocoaButton, CocoaCallout, CocoaCard, CocoaField, CocoaInput, toneColor, type CocoaTone } from "../components/cocoa";
import { CheckCircleIcon, ExclamationCircleIcon, InfoCircleIcon, XCircleIcon, type CocoaIconProps } from "../components/cocoa-icons/StatusIcons";
import { ACTIONS, FIELD_LABELS } from "../content/actions";

/** Eyebrow of every public auth screen (same as the login). */
export const AUTH_EYEBROW = "Anfitorio · Back Office";

const noop = () => {
  /* read-only / hidden controls have nothing to update */
};

export function AuthShell({
  label,
  children,
  footer
}: {
  /** Accessible name of the card region (the visible title of the screen). */
  label: string;
  children: ReactNode;
  /** Centred row of secondary actions under the body (CocoaButton plain). */
  footer?: ReactNode;
}) {
  return (
    <main
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
        aria-label={label}
        style={{ width: "100%", maxWidth: 440, display: "flex", flexDirection: "column", gap: "var(--cocoa-space-5)" }}
      >
        {children}
        {footer ? <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: "var(--cocoa-space-3)" }}>{footer}</div> : null}
      </CocoaCard>
    </main>
  );
}

export type AuthAlertTone = "error" | "success" | "info" | "warn";

const ALERT_TONE: Record<AuthAlertTone, CocoaTone> = { error: "danger", success: "success", info: "info", warn: "warning" };
const ALERT_ICON: Record<AuthAlertTone, ComponentType<CocoaIconProps>> = {
  error: XCircleIcon,
  success: CheckCircleIcon,
  info: InfoCircleIcon,
  warn: ExclamationCircleIcon
};

/**
 * Tinted note of the auth flows. These messages appear while the screen is
 * mounted (after a submit), so they are live: errors interrupt (`alert`), the
 * rest are announced politely (`status`).
 */
export function AuthAlert({ tone, title, children }: { tone: AuthAlertTone; title?: string; children: ReactNode }) {
  const Icon = ALERT_ICON[tone];
  return (
    <CocoaCallout tone={ALERT_TONE[tone]} title={title} icon={<Icon size={16} />} role={tone === "error" ? "alert" : "status"}>
      {children}
    </CocoaCallout>
  );
}

const checklistStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-1)",
  fontSize: "var(--cocoa-fs-callout)",
  lineHeight: "var(--cocoa-leading-text)",
  color: "var(--cocoa-label-secondary)"
};
const checkMetStyle: CSSProperties = { color: "var(--cocoa-label)" };
const checkIconStyle: CSSProperties = { color: toneColor("success") };
const pendingDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "var(--cocoa-radius-full)",
  background: "var(--cocoa-label-tertiary)",
  flexShrink: 0
};

/** Live checklist of the password policy (mirrors the server rules). */
export function PasswordChecklist({ password, policy }: { password: string; policy: PasswordPolicy }) {
  const checks = checkPassword(password, policy);
  return (
    <ul aria-label="Requisitos de la contraseña" style={checklistStyle}>
      {checks.map((check) => (
        <li key={check.key} className="cocoa-row" data-gap="2" data-wrap="nowrap" data-ok={check.ok ? "true" : "false"} style={check.ok ? checkMetStyle : undefined}>
          <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, flexShrink: 0 }}>
            {check.ok ? <CheckCircleIcon size={14} style={checkIconStyle} /> : <span style={pendingDotStyle} />}
          </span>
          <span>{check.label}</span>
          <span className="cocoa-sr-only">{check.ok ? ", cumplido" : ", pendiente"}</span>
        </li>
      ))}
    </ul>
  );
}

export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  disabled,
  autoFocus,
  error,
  help
}: {
  /** Stable id so the <label> and the password manager can find the control. */
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  disabled?: boolean;
  autoFocus?: boolean;
  /** Validation message painted under the control (aria-describedby / aria-invalid wired by CocoaField). */
  error?: string;
  help?: string;
}) {
  return (
    <CocoaField label={label} htmlFor={id} required error={error} help={help}>
      <CocoaInput id={id} type="password" autoComplete={autoComplete} size="large" autoFocus={autoFocus} value={value} onChange={onChange} disabled={disabled} />
    </CocoaField>
  );
}

/**
 * Username the password manager should store next to a new password. Never
 * shown: the wrapper is `hidden`, the control keeps `autocomplete="username"`.
 */
export function HiddenUsername({ email }: { email: string }) {
  return (
    <div hidden>
      <CocoaInput type="email" name="username" autoComplete="username" readOnly value={email} onChange={noop} aria-label={FIELD_LABELS.email} />
    </div>
  );
}

/** Copyable read-only value (invite / reset links) for the public screens. */
export function CopyLinkRow({
  id = "auth-copy-link",
  label,
  value,
  copied,
  onCopy
}: {
  id?: string;
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="cocoa-row" data-gap="2" data-align="end" data-wrap="nowrap">
      <CocoaField label={label} htmlFor={id} style={{ flex: "1 1 auto", minWidth: 0 }}>
        <CocoaInput id={id} readOnly value={value} onChange={noop} onFocus={(event) => event.currentTarget.select()} />
      </CocoaField>
      <CocoaButton variant="bordered" tone="neutral" onClick={onCopy} title={ACTIONS.copyLink}>
        {copied ? "Copiado" : ACTIONS.copy}
      </CocoaButton>
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
