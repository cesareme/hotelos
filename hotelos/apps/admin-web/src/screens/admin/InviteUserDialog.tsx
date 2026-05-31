// InviteUserDialog — generic dialog to invite an additional user to an
// existing tenant organization.
//
// This is the front-end peer of `POST /admin/tenants/:orgId/users`. The host
// (typically TenantDetailScreen) owns the network call via `onSubmit`; the
// dialog stays purely presentational and form-stateful so it can be reused
// from other tenant-scoped screens (e.g. property settings) without coupling
// to a specific API client.
//
// Form:
//   - email     (CocoaInput, required, type=email)
//   - fullName  (CocoaInput, required)
//   - property  (CocoaSelect, required, sourced from props)
//   - role      (CocoaSelect, required — fixed catalog of tenant roles)
//   - phone     (CocoaInput, optional)
//
// A11y:
//   - role="dialog" + aria-modal="true" + aria-labelledby on the title.
//   - ESC closes via onClose; overlay click also closes (unless submitting).
//   - First field receives focus when the dialog opens.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";

import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import { CocoaSelect, type CocoaSelectOption } from "../../components/cocoa/CocoaSelect";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InviteUserRole =
  | "Owner"
  | "GeneralManager"
  | "ShiftManager"
  | "Receptionist"
  | "Housekeeper"
  | "Maintenance"
  | "Accountant";

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

const ROLE_OPTIONS: Array<CocoaSelectOption & { value: InviteUserRole }> = [
  { value: "Owner", label: "Owner" },
  { value: "GeneralManager", label: "General Manager" },
  { value: "ShiftManager", label: "Shift Manager" },
  { value: "Receptionist", label: "Receptionist" },
  { value: "Housekeeper", label: "Housekeeper" },
  { value: "Maintenance", label: "Maintenance" },
  { value: "Accountant", label: "Accountant" }
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Styles (token-based; light/dark via cocoa-tokens.css)
// ---------------------------------------------------------------------------

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9999,
  background: "rgba(15, 23, 42, 0.55)",
  backdropFilter: "blur(2px)",
  WebkitBackdropFilter: "blur(2px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16
};

const dialogStyle: CSSProperties = {
  background: "var(--cocoa-background-elevated, var(--cocoa-background-content, #ffffff))",
  color: "var(--cocoa-label)",
  borderRadius: "var(--cocoa-radius-lg, 14px)",
  padding: "var(--cocoa-space-5, 20px)",
  boxShadow:
    "0 4px 14px rgba(26, 26, 26, 0.08), 0 24px 60px rgba(26, 26, 26, 0.18)",
  maxWidth: 520,
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-4, 16px)",
  fontFamily: "var(--cocoa-font)"
};

const titleStyle: CSSProperties = {
  margin: 0,
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-title-2, 18px)",
  fontWeight: 600,
  lineHeight: 1.3
};

const subtitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-subheadline, 13px)",
  lineHeight: 1.5
};

const formStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-3, 12px)"
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-1, 4px)"
};

const labelStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption, 11px)",
  color: "var(--cocoa-label-secondary)",
  textTransform: "uppercase",
  letterSpacing: "var(--cocoa-tracking-wide)",
  fontWeight: 600
};

const errorTextStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-caption, 11px)",
  color: "var(--cocoa-danger, #ff3b30)"
};

const footerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--cocoa-space-2, 8px)",
  marginTop: "var(--cocoa-space-2, 8px)"
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InviteUserDialog(props: InviteUserDialogProps) {
  const { open, onClose, orgId, properties, onSubmit } = props;

  const titleId = useId();
  const firstFieldRef = useRef<HTMLDivElement | null>(null);

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [role, setRole] = useState<InviteUserRole | "">("");
  const [phone, setPhone] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  // Reset state on open/close so the dialog is always fresh.
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
      // Focus first input on next frame so it's mounted.
      const id = window.setTimeout(() => {
        const input = firstFieldRef.current?.querySelector<HTMLInputElement>("input");
        input?.focus();
      }, 0);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // Per-field validity used both to gate submit and surface inline errors.
  const emailValid = EMAIL_RE.test(email.trim());
  const fullNameValid = fullName.trim().length > 0;
  const propertyValid = propertyId.length > 0;
  const roleValid = role.length > 0;

  const formValid = emailValid && fullNameValid && propertyValid && roleValid;

  const handleSubmit = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      if (event) event.preventDefault();
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
        // Parent decides whether to close; we close here as a sensible default.
        onClose();
      } catch (e) {
        setSubmitError(
          e instanceof Error ? e.message : "No se pudo enviar la invitación."
        );
      } finally {
        setSubmitting(false);
      }
    },
    [
      submitting,
      formValid,
      orgId,
      email,
      fullName,
      propertyId,
      role,
      phone,
      onSubmit,
      onClose
    ]
  );

  if (!open) return null;

  const propertyOptions: CocoaSelectOption[] = properties.map((p) => ({
    value: p.id,
    label: p.name
  }));

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && !submitting) {
      e.stopPropagation();
      onClose();
    }
  }

  function fieldError(message: string): ReactNode {
    if (!showErrors) return null;
    return <p style={errorTextStyle}>{message}</p>;
  }

  return (
    <div
      role="presentation"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (submitting) return;
        if (e.target === e.currentTarget) onClose();
      }}
      style={overlayStyle}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={dialogStyle}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 id={titleId} style={titleStyle}>
            Invitar usuario
          </h2>
          <p style={subtitleStyle}>
            Envía una invitación por email para añadir un usuario al tenant. El
            destinatario recibirá un enlace para activar su cuenta.
          </p>
        </div>

        <form onSubmit={handleSubmit} style={formStyle} noValidate>
          <div style={fieldStyle} ref={firstFieldRef}>
            <label style={labelStyle} htmlFor={`${titleId}-email`}>
              Email
            </label>
            <CocoaInput
              value={email}
              onChange={setEmail}
              placeholder="usuario@empresa.com"
              type="email"
              inputMode="email"
              required
              disabled={submitting}
              error={showErrors && !emailValid}
            />
            {!emailValid ? fieldError("Introduce un email válido.") : null}
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>Nombre completo</label>
            <CocoaInput
              value={fullName}
              onChange={setFullName}
              placeholder="Nombre y apellidos"
              required
              disabled={submitting}
              error={showErrors && !fullNameValid}
            />
            {!fullNameValid ? fieldError("El nombre es obligatorio.") : null}
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>Propiedad</label>
            <CocoaSelect
              value={propertyId}
              onChange={setPropertyId}
              options={propertyOptions}
              placeholder={
                properties.length === 0
                  ? "No hay propiedades disponibles"
                  : "Selecciona una propiedad…"
              }
              disabled={submitting || properties.length === 0}
            />
            {!propertyValid ? fieldError("Selecciona una propiedad.") : null}
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>Rol</label>
            <CocoaSelect
              value={role}
              onChange={(v) => setRole(v as InviteUserRole)}
              options={ROLE_OPTIONS}
              placeholder="Selecciona un rol…"
              disabled={submitting}
            />
            {!roleValid ? fieldError("Selecciona un rol.") : null}
          </div>

          <div style={fieldStyle}>
            <label style={labelStyle}>Teléfono (opcional)</label>
            <CocoaInput
              value={phone}
              onChange={setPhone}
              placeholder="+34 600 000 000"
              type="tel"
              inputMode="tel"
              disabled={submitting}
            />
          </div>

          {submitError ? (
            <p
              role="alert"
              style={{
                ...errorTextStyle,
                fontSize: "var(--cocoa-fs-subheadline, 13px)"
              }}
            >
              {submitError}
            </p>
          ) : null}

          <div style={footerStyle}>
            <CocoaButton
              type="button"
              variant="bordered"
              tone="neutral"
              onClick={onClose}
              disabled={submitting}
            >
              Cancelar
            </CocoaButton>
            <CocoaButton
              type="submit"
              variant="filled"
              tone="accent"
              loading={submitting}
              disabled={submitting}
            >
              Enviar invitación
            </CocoaButton>
          </div>
        </form>
      </div>
    </div>
  );
}

export default InviteUserDialog;
