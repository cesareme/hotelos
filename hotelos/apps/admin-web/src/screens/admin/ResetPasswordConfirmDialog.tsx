// ResetPasswordConfirmDialog — small CocoaSheet dialog for re-issuing a
// tenant user's one-time temporary password.
//
// Two-step UX:
//   1. Confirmation step  — explains the action and asks for confirmation.
//      Footer: [Cancelar] [Confirmar reset].
//   2. Result step        — shows the freshly generated `newPassword` with a
//      copy-to-clipboard affordance. Footer: [Cerrar].
//
// The dialog is "dumb": it does not call the API itself. The caller supplies
// `onConfirm`, an async function that returns `{ newPassword }`. This keeps
// the dialog reusable across screens (super-admin console, tenant detail
// drawer, etc.) and lets the caller decide how to surface the action
// (kebab menu, row action, dedicated CTA, etc.).
//
// `orgId` / `userId` are accepted as props so that the caller can pass the
// identifiers it already has and the dialog can be later extended (e.g.
// audit logging, telemetry) without changing call sites.

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties
} from "react";

import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaSheet } from "../../components/cocoa/CocoaSheet";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResetPasswordConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  userEmail: string;
  orgId: string;
  userId: string;
  /**
   * Called when the operator confirms the reset. Must return the newly
   * generated temporary password so the dialog can present it for copy.
   */
  onConfirm: () => Promise<{ newPassword: string }>;
}

// ---------------------------------------------------------------------------
// Styles (token-based)
// ---------------------------------------------------------------------------

const bodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-3)",
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label)"
};

const leadStyle: CSSProperties = {
  margin: 0,
  color: "var(--cocoa-label)",
  lineHeight: 1.4
};

const helperStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  lineHeight: 1.4
};

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-danger)",
  lineHeight: 1.4
};

const emphasisStyle: CSSProperties = {
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  color: "var(--cocoa-label)"
};

const passwordRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: "var(--cocoa-space-2)"
};

const passwordBoxStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
  background: "var(--cocoa-background-control)",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-md)",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label)",
  letterSpacing: "var(--cocoa-tracking-wide)",
  userSelect: "all",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--cocoa-space-2)"
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Step = "confirm" | "result";

export function ResetPasswordConfirmDialog({
  open,
  onClose,
  userEmail,
  orgId: _orgId,
  userId: _userId,
  onConfirm
}: ResetPasswordConfirmDialogProps) {
  // `orgId` / `userId` are accepted for the API contract but the dialog
  // delegates execution to `onConfirm`. We touch them here so the linter
  // doesn't flag them as unused while still keeping them in the prop shape.
  void _orgId;
  void _userId;

  const [step, setStep] = useState<Step>("confirm");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState<string>("");
  const [copied, setCopied] = useState<boolean>(false);

  // Reset internal state whenever the dialog re-opens.
  useEffect(() => {
    if (!open) return;
    setStep("confirm");
    setSubmitting(false);
    setError(null);
    setNewPassword("");
    setCopied(false);
  }, [open]);

  const handleConfirm = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { newPassword: pwd } = await onConfirm();
      setNewPassword(pwd);
      setStep("result");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [onConfirm]);

  const handleCopy = useCallback(async () => {
    if (!newPassword) return;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(newPassword);
      } else if (typeof document !== "undefined") {
        // Fallback for browsers without the async clipboard API.
        const ta = document.createElement("textarea");
        ta.value = newPassword;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [newPassword]);

  // While submitting, swallow close requests so the user can't close mid-flight.
  const handleClose = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [submitting, onClose]);

  const title = useMemo(
    () =>
      step === "confirm"
        ? "Reset password temporal"
        : "Nuevo password temporal",
    [step]
  );

  const footer = useMemo(() => {
    if (step === "confirm") {
      return (
        <div style={footerStyle}>
          <CocoaButton
            variant="bordered"
            tone="neutral"
            onClick={handleClose}
            disabled={submitting}
          >
            Cancelar
          </CocoaButton>
          <CocoaButton
            variant="filled"
            tone="destructive"
            onClick={handleConfirm}
            loading={submitting}
          >
            Confirmar reset
          </CocoaButton>
        </div>
      );
    }
    return (
      <div style={footerStyle}>
        <CocoaButton variant="filled" tone="accent" onClick={onClose}>
          Cerrar
        </CocoaButton>
      </div>
    );
  }, [step, submitting, handleClose, handleConfirm, onClose]);

  return (
    <CocoaSheet
      open={open}
      onClose={handleClose}
      size="sm"
      title={title}
      footer={footer}
    >
      {step === "confirm" ? (
        <div style={bodyStyle}>
          <p style={leadStyle}>
            Generar nuevo password temporal para{" "}
            <span style={emphasisStyle}>{userEmail}</span>.
          </p>
          <p style={helperStyle}>
            El usuario tendrá que cambiarlo en su primer login.
          </p>
          {error ? <p style={errorStyle}>{error}</p> : null}
        </div>
      ) : (
        <div style={bodyStyle}>
          <p style={leadStyle}>
            Password temporal generado para{" "}
            <span style={emphasisStyle}>{userEmail}</span>. Cópialo y
            entrégalo al usuario por un canal seguro: no podrás volver a
            verlo.
          </p>
          <div style={passwordRowStyle}>
            <div
              style={passwordBoxStyle}
              aria-label="Password temporal"
              role="textbox"
              aria-readonly="true"
            >
              {newPassword}
            </div>
            <CocoaButton
              variant="bordered"
              tone="accent"
              size="small"
              onClick={handleCopy}
            >
              {copied ? "Copiado" : "Copiar"}
            </CocoaButton>
          </div>
          <p style={helperStyle}>
            El usuario tendrá que cambiarlo en su primer login.
          </p>
          {error ? <p style={errorStyle}>{error}</p> : null}
        </div>
      )}
    </CocoaSheet>
  );
}

export default ResetPasswordConfirmDialog;
