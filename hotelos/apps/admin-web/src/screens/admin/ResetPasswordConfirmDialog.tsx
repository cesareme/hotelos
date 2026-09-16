// ResetPasswordConfirmDialog — small dialog for re-issuing a tenant user's
// one-time temporary password.
//
// Two steps:
//   1. Confirmation — explains the action and asks for confirmation
//      (destructive CocoaDialog: [Cancelar] [Generar contraseña]).
//   2. Result       — shows the freshly generated `newPassword` with a copy
//      button (single-button CocoaDialog: [Cerrar]).
//
// The dialog is «dumb»: it does not call the API itself. The caller supplies
// `onConfirm`, an async function that returns `{ newPassword }`, so the dialog
// is reusable across screens and the caller decides how to surface it.
//
// `orgId` / `userId` are accepted as props so the caller can pass the
// identifiers it already has and the dialog can later be extended (audit
// logging, telemetry) without changing call sites.
//
// Cocoa 22 (lote 10-A · diálogo): CocoaDialog owns the layer (focus trap, Esc
// and scrim never while busy); the password is a read-only CocoaInput.

import { useCallback, useEffect, useState } from "react";
import { copyText } from "../../services/authApi";
import { ACTIONS } from "../../content/actions";
import { CocoaButton, CocoaCallout, CocoaDialog, CocoaInput } from "../../components/cocoa";

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
// Component
// ---------------------------------------------------------------------------

type Step = "confirm" | "result";

export function ResetPasswordConfirmDialog({ open, onClose, userEmail, orgId: _orgId, userId: _userId, onConfirm }: ResetPasswordConfirmDialogProps) {
  // `orgId` / `userId` are accepted for the API contract but the dialog
  // delegates execution to `onConfirm`; touched so they are not flagged unused.
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
    if (await copyText(newPassword)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      setError("No se pudo copiar al portapapeles: selecciona la contraseña y cópiala a mano.");
    }
  }, [newPassword]);

  if (step === "confirm") {
    return (
      <CocoaDialog
        open={open}
        onClose={onClose}
        tone="destructive"
        title="Restablecer la contraseña temporal"
        description={`Se generará una contraseña temporal nueva para ${userEmail}. La anterior dejará de funcionar y el usuario tendrá que cambiarla en su primer inicio de sesión.`}
        confirmLabel="Generar contraseña"
        cancelLabel={ACTIONS.cancel}
        busy={submitting}
        onConfirm={handleConfirm}
      >
        {error ? (
          <CocoaCallout tone="danger" title="No se pudo restablecer la contraseña" role="alert">
            {error}
          </CocoaCallout>
        ) : null}
      </CocoaDialog>
    );
  }

  return (
    <CocoaDialog
      open={open}
      onClose={onClose}
      title="Contraseña temporal generada"
      description={`Contraseña temporal para ${userEmail}. Cópiala y entrégala al usuario por un canal seguro: no podrás volver a verla.`}
      confirmLabel={ACTIONS.close}
      hideCancel
      onConfirm={onClose}
    >
      <div className="cocoa-stack" data-gap="2">
        <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
          <CocoaInput value={newPassword} onChange={() => undefined} readOnly aria-label="Contraseña temporal" className="cocoa-mono" style={{ flex: "1 1 auto", minWidth: 0 }} />
          <CocoaButton variant="bordered" tone="accent" size="small" onClick={() => void handleCopy()}>
            {copied ? "Copiado" : ACTIONS.copy}
          </CocoaButton>
        </div>
        <p className="cocoa-note">El usuario tendrá que cambiarla en su primer inicio de sesión.</p>
        {error ? (
          <CocoaCallout tone="danger" role="alert">
            {error}
          </CocoaCallout>
        ) : null}
      </div>
    </CocoaDialog>
  );
}

export default ResetPasswordConfirmDialog;
