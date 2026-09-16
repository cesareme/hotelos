// InviteUserDialog — generic dialog to invite an additional user to an
// existing tenant organization.
//
// Front-end peer of `POST /admin/tenants/:orgId/users`. The host owns the
// network call via `onSubmit`; the dialog stays purely presentational and
// form-stateful so it can be reused from other tenant-scoped screens without
// coupling to a specific API client.
//
// Form (CocoaField + CocoaInput / CocoaSelect):
//   - email     (required, type=email)
//   - fullName  (required)
//   - property  (required, sourced from props)
//   - role      (required — fixed catalog of tenant roles, Spanish labels)
//   - phone     (optional)
//
// Cocoa 22 (lote 10-A · diálogo): CocoaDialog owns the layer — role=dialog,
// aria-modal, focus trap, Esc and scrim (never while submitting), initial
// focus on the first field — and awaits `onConfirm`; an invalid form paints
// its errors instead of closing.

import { useCallback, useEffect, useId, useState } from "react";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { CocoaCallout, CocoaDialog, CocoaField, CocoaInput, CocoaSelect, type CocoaSelectOption } from "../../components/cocoa";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InviteUserRole = "Owner" | "GeneralManager" | "ShiftManager" | "Receptionist" | "Housekeeper" | "Maintenance" | "Accountant";

export type InviteUserProperty = {
  id: string;
  name: string;
};

export type InviteUserPayload = {
  orgId: string;
  email: string;
  fullName: string;
  propertyId: string;
  role: InviteUserRole;
  phone?: string;
};

export interface InviteUserDialogProps {
  open: boolean;
  onClose: () => void;
  orgId: string;
  properties: InviteUserProperty[];
  onSubmit: (payload: InviteUserPayload) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Values are the API's role keys; labels follow the Spanish role templates
// (Propietario, Dirección, Recepción, Pisos, Mantenimiento, Contabilidad).
const ROLE_OPTIONS: Array<CocoaSelectOption & { value: InviteUserRole }> = [
  { value: "Owner", label: "Propietario" },
  { value: "GeneralManager", label: "Dirección" },
  { value: "ShiftManager", label: "Jefe de turno" },
  { value: "Receptionist", label: "Recepción" },
  { value: "Housekeeper", label: "Pisos" },
  { value: "Maintenance", label: "Mantenimiento" },
  { value: "Accountant", label: "Contabilidad" }
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InviteUserDialog(props: InviteUserDialogProps) {
  const { open, onClose, orgId, properties, onSubmit } = props;

  const emailId = `${useId()}-email`;

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [role, setRole] = useState<InviteUserRole | "">("");
  const [phone, setPhone] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  // Reset state on open so the dialog is always fresh.
  useEffect(() => {
    if (open) {
      setEmail("");
      setFullName("");
      setPropertyId("");
      setRole("");
      setPhone("");
      setSubmitting(false);
      setSubmitError(null);
      setShowErrors(false);
    }
  }, [open]);

  // Per-field validity used both to gate submit and surface inline errors.
  const emailValid = EMAIL_RE.test(email.trim());
  const fullNameValid = fullName.trim().length > 0;
  const propertyValid = propertyId.length > 0;
  const roleValid = role.length > 0;

  const formValid = emailValid && fullNameValid && propertyValid && roleValid;

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    if (!formValid) {
      setShowErrors(true);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload: InviteUserPayload = {
        orgId,
        email: email.trim(),
        fullName: fullName.trim(),
        propertyId,
        role: role as InviteUserRole
      };
      const trimmedPhone = phone.trim();
      if (trimmedPhone) {
        payload.phone = trimmedPhone;
      }
      await onSubmit(payload);
      // The parent decides whether to close; closing here is the sensible default.
      onClose();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "No se pudo enviar la invitación.");
    } finally {
      setSubmitting(false);
    }
  }, [submitting, formValid, orgId, email, fullName, propertyId, role, phone, onSubmit, onClose]);

  const propertyOptions: CocoaSelectOption[] = properties.map((p) => ({ value: p.id, label: p.name }));

  return (
    <CocoaDialog
      open={open}
      onClose={onClose}
      size="md"
      title="Invitar usuario"
      description="Envía una invitación por email para añadir un usuario a la organización. El destinatario recibirá un enlace para activar su cuenta."
      confirmLabel="Enviar invitación"
      cancelLabel={ACTIONS.cancel}
      busy={submitting}
      onConfirm={handleSubmit}
      initialFocus={() => document.getElementById(emailId)}
    >
      <div className="cocoa-stack" data-gap="3">
        <CocoaField label="Correo electrónico" required error={showErrors && !emailValid ? "Introduce un email válido." : undefined}>
          <CocoaInput id={emailId} value={email} onChange={setEmail} placeholder="usuario@empresa.com" type="email" inputMode="email" autoComplete="off" disabled={submitting} />
        </CocoaField>
        <CocoaField label="Nombre completo" required error={showErrors && !fullNameValid ? "El nombre es obligatorio." : undefined}>
          <CocoaInput value={fullName} onChange={setFullName} placeholder="Nombre y apellidos" autoComplete="off" disabled={submitting} />
        </CocoaField>
        <CocoaField label="Centro de trabajo" required error={showErrors && !propertyValid ? "Selecciona un centro." : undefined}>
          <CocoaSelect
            value={propertyId}
            onChange={setPropertyId}
            options={propertyOptions}
            placeholder={properties.length === 0 ? "No hay centros disponibles" : "Selecciona un centro…"}
            disabled={submitting || properties.length === 0}
          />
        </CocoaField>
        <CocoaField label="Rol" required error={showErrors && !roleValid ? "Selecciona un rol." : undefined}>
          <CocoaSelect value={role} onChange={(v) => setRole(v as InviteUserRole)} options={ROLE_OPTIONS} placeholder="Selecciona un rol…" disabled={submitting} />
        </CocoaField>
        <CocoaField label="Teléfono" hint={STATUS_LABELS.optional.toLowerCase()}>
          <CocoaInput value={phone} onChange={setPhone} placeholder="+34 600 000 000" type="tel" inputMode="tel" autoComplete="off" disabled={submitting} />
        </CocoaField>
        {submitError ? (
          <CocoaCallout tone="danger" title="No se pudo enviar la invitación" role="alert">
            {submitError}
          </CocoaCallout>
        ) : null}
      </div>
    </CocoaDialog>
  );
}

export default InviteUserDialog;
