// «Mi PIN de supervisor» (Tanda 8a · corrector FX-02, design §5.6 / D8).
//
// The supervisor PIN authorises the actions of OTHER colleagues (a refund
// above their tier, a void, a discount) without lending them the session. The
// people who authorise by PIN are the N2 supervisors (jefatura de recepción,
// gobernanta, encargado de mantenimiento, jefatura de A&B): templates whose
// tokens never open Configuración › Usuarios y roles, so the PIN cannot live
// only there. This dialog hangs from the user menu of the shell
// (layouts/BackOfficeLayout.tsx → «Mi PIN de supervisor») for EVERY signed-in
// user and calls POST /rbac/pin with the user's own password (the API hashes
// the PIN with scrypt; five failures lock it 15 minutes). Nothing about the
// PIN survives the dialog. Cocoa 22: CocoaDialog + CocoaField/CocoaInput, no
// inline style, Spanish only; every call through services/rbacApi.ts.

import { useEffect, useMemo, useState } from "react";
import { CocoaCallout } from "./cocoa/CocoaCallout";
import { CocoaDialog } from "./cocoa/CocoaDialog";
import { CocoaField, CocoaFormRow } from "./cocoa/CocoaField";
import { CocoaInput } from "./cocoa/CocoaInput";
import { ACTIONS } from "../content/actions";
import { rbacErrorMessage, setOwnPin } from "../services/rbacApi";

const PIN_PATTERN = /^\d{4,8}$/;

export type SupervisorPinSettingsDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Called after the PIN is stored (the caller shows the toast). */
  onSaved?: (result: { pinUpdatedAt: string }) => void;
};

/** Pure: whether the form can be sent (password present, PIN of 4-8 digits, both PIN fields equal). */
export function pinFormValid(input: { password: string; pin: string; confirmation: string }): boolean {
  return input.password.length > 0 && PIN_PATTERN.test(input.pin) && input.pin === input.confirmation;
}

export function SupervisorPinSettingsDialog(props: SupervisorPinSettingsDialogProps) {
  const { open, onClose, onSaved } = props;
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // A fresh form every time it opens: neither the password nor a PIN survive.
  useEffect(() => {
    if (!open) return;
    setPassword("");
    setPin("");
    setConfirmation("");
    setError(null);
    setSavedAt(null);
  }, [open]);

  const valid = useMemo(() => pinFormValid({ password, pin, confirmation }), [password, pin, confirmation]);
  const mismatch = confirmation.length > 0 && pin !== confirmation;

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await setOwnPin({ password, pin });
      setPassword("");
      setPin("");
      setConfirmation("");
      setSavedAt(result.pinUpdatedAt);
      onSaved?.({ pinUpdatedAt: result.pinUpdatedAt });
      onClose();
    } catch (failure) {
      setError(rbacErrorMessage(failure, "No se ha podido guardar el PIN."));
      setPin("");
      setConfirmation("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CocoaDialog
      open={open}
      onClose={onClose}
      title="Mi PIN de supervisor"
      description="Con tu PIN autorizas acciones de otros compañeros (una devolución o un descuento fuera de su tramo, la anulación de un tique) sin cederles tu sesión: la autorización vale 60 segundos, solo para esa acción, y queda en el registro de auditoría con tu nombre. De 4 a 8 dígitos; se guarda cifrado y cinco intentos fallidos lo bloquean 15 minutos."
      confirmLabel={busy ? "Guardando…" : "Guardar PIN"}
      cancelLabel={ACTIONS.cancel}
      onConfirm={() => void save()}
      busy={busy}
      confirmDisabled={!valid}
      size="md"
    >
      <div className="cocoa-stack" data-gap="3">
        <CocoaFormRow columns={1}>
          <CocoaField label="Tu contraseña" required help="Cambiar el PIN exige volver a identificarte.">
            <CocoaInput value={password} onChange={setPassword} type="password" autoComplete="current-password" disabled={busy} />
          </CocoaField>
          <CocoaField label="Nuevo PIN" required>
            <CocoaInput value={pin} onChange={(value) => setPin(value.replace(/\D/g, "").slice(0, 8))} type="password" inputMode="numeric" autoComplete="off" maxLength={8} disabled={busy} aria-label="Nuevo PIN de supervisor" />
          </CocoaField>
          <CocoaField label="Repite el PIN" required error={mismatch ? "Los dos PIN no coinciden." : undefined}>
            <CocoaInput value={confirmation} onChange={(value) => setConfirmation(value.replace(/\D/g, "").slice(0, 8))} type="password" inputMode="numeric" autoComplete="off" maxLength={8} disabled={busy} aria-label="Repetir el PIN de supervisor" />
          </CocoaField>
        </CocoaFormRow>
        <p className="cocoa-note">Solo sirve si tu plantilla tiene la clave que autoriza (aprobar descuentos, ajustes, devoluciones o anular tiques) en el hotel donde te lo piden; nadie puede fijarle el PIN a otra persona.</p>
        {error ? (
          <CocoaCallout tone="danger" title="No guardado" role="alert">
            {error}
          </CocoaCallout>
        ) : null}
        {savedAt ? (
          <CocoaCallout tone="success" title="PIN guardado" role="status">
            {null}
          </CocoaCallout>
        ) : null}
      </div>
    </CocoaDialog>
  );
}

export default SupervisorPinSettingsDialog;
