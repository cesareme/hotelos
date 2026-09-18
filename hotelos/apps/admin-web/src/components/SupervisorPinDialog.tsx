// PIN de supervisor (Tanda 8a · L4, design §5.6 · OPERA pattern).
//
// When an operative pulls an action that needs an `*.override` / `*_approve`
// key they do not hold, this dialog asks a supervisor who is present for their
// e-mail, their PIN and a reason code, calls POST /rbac/supervisor-authorizations
// (the API checks the authoriser's PIN and that THEY hold the requested key in
// the property; 5 failures lock the PIN 15 minutes) and hands the caller the
// authorisation id to resend as `supervisorAuthorizationId` on the action
// (bound to one entity, 60 s). Nothing about the authoriser is stored in the
// browser; the PIN never leaves the form.
//
// Mounted by the action of the operative who lacks the key (corrector 8a ·
// FX-03): the refund dialog (components/billing/RefundDialog.tsx, key
// payments.refund_approve, on 409 APPROVAL_REQUIRED); the POS void and the
// reception override (rate / restriction / overbooking) mount it the same way:
// `<SupervisorPinDialog open permissionKey entityType entityId propertyId
// amount onAuthorized={(auth) => …} onClose={…} />`. The supervisor sets the
// PIN from the user menu (components/SupervisorPinSettingsDialog.tsx).
// Cocoa 22: CocoaDialog + CocoaField/CocoaInput, no inline style, Spanish only.

import { useEffect, useMemo, useState } from "react";
import { SUPERVISOR_AUTHORIZATION_TTL_SECONDS, type SupervisorAuthorizationDto } from "@hotelos/shared";
import { CocoaCallout } from "./cocoa/CocoaCallout";
import { CocoaDialog } from "./cocoa/CocoaDialog";
import { CocoaField, CocoaFormRow } from "./cocoa/CocoaField";
import { CocoaInput } from "./cocoa/CocoaInput";
import { CocoaSelect } from "./cocoa/CocoaSelect";
import { ACTIONS } from "../content/actions";
import { errorCodeOf, rbacErrorMessage, requestSupervisorAuthorization } from "../services/rbacApi";

/** Reason codes of the override catalogues (design §4.7: `rate_override_reason`, `adjustment_reason`, `void_reason`). */
export const SUPERVISOR_REASONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "guest_complaint", label: "Queja del huésped" },
  { value: "service_failure", label: "Fallo del servicio" },
  { value: "commercial_agreement", label: "Acuerdo comercial" },
  { value: "operational_error", label: "Error operativo" },
  { value: "vip", label: "Huésped VIP" },
  { value: "other", label: "Otro motivo (indicar en la nota)" }
];

const PIN_PATTERN = /^\d{4,8}$/;

export type SupervisorPinDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Key the action needs (`pms.reservation.override`, `pos.order.void`, `folio.adjust_approve`…). */
  permissionKey: string;
  entityType: string;
  entityId: string;
  /** Property the action happens in (the authoriser must hold the key there). */
  propertyId: string;
  /** Decimal string with at most two decimals, when the action carries an amount. */
  amount?: string;
  /** What the operative is trying to do, in Spanish («Anular el ticket 214»). */
  actionLabel: string;
  /** Receives the authorisation; the caller resends `authorization.id` as `supervisorAuthorizationId`. */
  onAuthorized: (authorization: SupervisorAuthorizationDto) => void;
};

export function SupervisorPinDialog(props: SupervisorPinDialogProps) {
  const { open, onClose, permissionKey, entityType, entityId, propertyId, amount, actionLabel, onAuthorized } = props;
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [reasonCode, setReasonCode] = useState(SUPERVISOR_REASONS[0].value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  // A fresh dialog every time it opens: the PIN of a previous attempt never survives.
  useEffect(() => {
    if (!open) return;
    setEmail("");
    setPin("");
    setReasonCode(SUPERVISOR_REASONS[0].value);
    setError(null);
    setLocked(false);
  }, [open]);

  const valid = useMemo(() => email.trim().includes("@") && PIN_PATTERN.test(pin) && reasonCode.length > 0, [email, pin, reasonCode]);

  async function authorize() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const authorization = await requestSupervisorAuthorization({
        authorizerEmail: email.trim(),
        pin,
        permissionKey,
        entityType,
        entityId,
        propertyId,
        ...(amount ? { amount } : {}),
        reasonCode
      });
      setPin("");
      onAuthorized(authorization);
    } catch (failure) {
      const code = errorCodeOf(failure);
      setLocked(code === "SUPERVISOR_PIN_LOCKED");
      setError(rbacErrorMessage(failure, "No se ha podido autorizar la acción."));
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CocoaDialog
      open={open}
      onClose={onClose}
      title="Autorización de un supervisor"
      description={`${actionLabel} exige la clave «${permissionKey}», que tu perfil no tiene. Un supervisor presente puede autorizar solo esta acción con su PIN; la autorización caduca en ${SUPERVISOR_AUTHORIZATION_TTL_SECONDS} segundos y queda en el registro de auditoría con actor, autorizador, motivo e importe.`}
      confirmLabel={busy ? "Comprobando…" : "Autorizar"}
      cancelLabel={ACTIONS.cancel}
      onConfirm={() => void authorize()}
      busy={busy}
      confirmDisabled={!valid || locked}
      size="md"
    >
      <div className="cocoa-stack" data-gap="3">
        <CocoaFormRow columns={1}>
          <CocoaField label="Correo del supervisor" required help="Debe tener la clave en este hotel y un PIN configurado (menú de usuario › Mi PIN de supervisor).">
            <CocoaInput value={email} onChange={setEmail} type="email" inputMode="email" autoComplete="off" disabled={busy} placeholder="jefatura.recepcion@hotel.test" />
          </CocoaField>
          <CocoaField label="PIN" required help="De 4 a 8 dígitos. Cinco intentos fallidos lo bloquean 15 minutos.">
            <CocoaInput value={pin} onChange={(value) => setPin(value.replace(/\D/g, "").slice(0, 8))} type="password" inputMode="numeric" autoComplete="one-time-code" disabled={busy} maxLength={8} aria-label="PIN del supervisor" />
          </CocoaField>
          <CocoaField label="Motivo" required>
            <CocoaSelect value={reasonCode} onChange={setReasonCode} options={SUPERVISOR_REASONS.map((reason) => ({ value: reason.value, label: reason.label }))} disabled={busy} />
          </CocoaField>
        </CocoaFormRow>
        {amount ? <p className="cocoa-note">Importe de la acción: {amount}. El supervisor solo puede autorizar hasta el tramo de su nivel.</p> : null}
        {error ? (
          <CocoaCallout tone="danger" title={locked ? "PIN bloqueado" : "No autorizado"} role="alert">
            {error}
          </CocoaCallout>
        ) : null}
      </div>
    </CocoaDialog>
  );
}

export default SupervisorPinDialog;
