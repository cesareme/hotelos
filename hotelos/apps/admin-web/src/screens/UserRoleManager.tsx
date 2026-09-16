// User Role Manager — Configuración › Usuarios y roles (/configuracion/usuarios).
//
// Invite and govern Back Office users for the active property. Reads
// GET /backoffice/properties/:propertyId/users and exposes:
//
//   • «Invitar usuario» (CocoaDrawer): name, email, phone and the ROLE
//     (GET /backoffice/properties/:propertyId/roles — the organization's
//     Prisma roles, provisioned from the Spanish templates). POST /users/invite
//     persists the user + a single-use invitation and reports how the email
//     really went out: only a real `delivery.status === "sent"` is announced
//     as «Invitación enviada»; when the server email is simulated / disabled /
//     failed the copyable invite link is shown instead (Tanda 3 · CFG-P1-6).
//   • a row drawer with the detail, «Reenviar invitación» (POST
//     /users/:userId/reissue-invite, revokes the previous tokens) for invited
//     users and «Desactivar» (POST /users/:userId/disable) behind a CocoaDialog.
//   • «Cambiar rol» scoped to the user's primary department assignment when
//     one exists (department `roleLabel`, displayed as-is).
//
// Cocoa 22 (lote 10-A · workspace): CocoaPage → CocoaSection padding="none"
// with the CocoaTable (a row opens its drawer) → two CocoaDrawer (invite,
// detail) with two-button footers → CocoaDialog destructive with `busy`.
// Permissions: users.invite and users.disable. Failures surface via toast.

import { useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../services/activeProperty";
import { useApiData } from "../hooks/useApiData";
import { apiRequest } from "../services/api-client";
import {
  copyText,
  describeDelivery,
  describePendingInvitation,
  fetchEmailStatus,
  fetchPropertyRoles,
  formatExpiry,
  inviteBackOfficeUser,
  reissueBackOfficeInvitation,
  type BackOfficeUserRecord,
  type EmailStatus,
  type InvitationResult,
  type PropertyRole
} from "../services/authApi";
import { useToast } from "../components/Toast";
import { ACTIONS, STATUS_LABELS } from "../content/actions";
import { toArray } from "../utils/toArray";
import { dateTime, plural } from "../lib/format";
import { useTabHost } from "./tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormSection,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

type DepartmentAssignment = {
  id: string;
  userId: string;
  departmentId: string;
  roleLabel?: string;
  active: boolean;
  department?: { id: string; name: string; code: string };
};

// GET …/users row: the shared record (with the token-free `pendingInvitation`
// summary for invited users) plus the department assignments.
type BackOfficeUser = BackOfficeUserRecord & {
  departments: DepartmentAssignment[];
};

type LegacyTone = "ok" | "warn" | "error" | "info";

/** Semantic tone of the authApi helpers («ok» / «warn» / «error») → Cocoa tone. */
const TONE: Record<LegacyTone, CocoaTone> = { ok: "success", warn: "warning", error: "danger", info: "info" };

const STATUS_LABEL: Record<BackOfficeUser["status"], string> = {
  active: STATUS_LABELS.active,
  invited: "Invitado · pendiente",
  disabled: STATUS_LABELS.disabled
};
const STATUS_KIND: Record<BackOfficeUser["status"], LegacyTone> = {
  active: "ok",
  invited: "warn",
  disabled: "error"
};

/**
 * Status tag of a row. Invited users read their real invitation state from
 * `pendingInvitation` (expiry / expired); when the API does not expose it the
 * bare status is shown instead of guessing.
 */
function statusBadge(user: BackOfficeUser): { tone: CocoaTone; label: string; detail?: string } {
  if (user.status === "invited") {
    const pending = describePendingInvitation(user.pendingInvitation);
    if (pending) return { tone: TONE[pending.tone], label: pending.tone === "error" ? "Invitación caducada" : pending.label, detail: pending.detail };
  }
  return { tone: TONE[STATUS_KIND[user.status] ?? "info"], label: STATUS_LABEL[user.status] ?? user.status };
}

function fmtDateTime(iso?: string): string {
  return dateTime(iso, { style: "medium" });
}

function primaryRole(user: BackOfficeUser): string {
  const assignment = (user.departments ?? []).find((d) => d.active);
  if (!assignment) return "—";
  if (assignment.roleLabel) return assignment.roleLabel;
  return assignment.department?.name ?? assignment.departmentId;
}

/** Read-only value with a copy button (the invite link to hand over by another channel). */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    if (await copyText(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }
  return (
    <div className="cocoa-stack" data-gap="1">
      <span className="cocoa-caption">{label}</span>
      <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
        <CocoaInput value={value} onChange={() => undefined} readOnly aria-label={label} style={{ flex: "1 1 auto", minWidth: 0 }} />
        <CocoaButton variant="bordered" tone="neutral" onClick={() => void handleCopy()}>
          {copied ? "Copiado" : ACTIONS.copy}
        </CocoaButton>
      </div>
    </div>
  );
}

/**
 * Honest outcome of an invitation: success only for a real send; otherwise the
 * link to hand over by another channel, plus the expiry.
 */
function InvitationOutcome({ email, invitation }: { email: string; invitation: InvitationResult | undefined }) {
  const delivery = describeDelivery(invitation?.delivery, email);
  const showLink = Boolean(invitation?.inviteUrl) && invitation?.delivery?.status !== "sent";
  return (
    <div className="cocoa-stack" data-gap="3">
      <CocoaCallout tone={TONE[delivery.tone]} title={delivery.title} role="status">
        {delivery.detail}
      </CocoaCallout>
      {showLink && invitation ? <CopyField label="Enlace de invitación (un solo uso)" value={invitation.inviteUrl} /> : null}
      <p className="cocoa-note">Caduca el {formatExpiry(invitation?.expiresAt)}. Reenviar la invitación genera un enlace nuevo y anula este.</p>
    </div>
  );
}

export function UserRoleManager() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const { data, loading, error, refresh } = useApiData<BackOfficeUser[]>(`/backoffice/properties/${PROPERTY_ID}/users`);

  const users = useMemo<BackOfficeUser[]>(() => toArray<BackOfficeUser>(data), [data]);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Roles of the organization + outbound email mode, loaded when the invite
  // drawer opens (both are cheap; roles decide whether inviting is possible).
  const [roles, setRoles] = useState<PropertyRole[] | null>(null);
  const [rolesError, setRolesError] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<EmailStatus | null>(null);

  // Invite form state.
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePhone, setInvitePhone] = useState("");
  const [inviteRoleId, setInviteRoleId] = useState("");
  // MFA is stored on the user but the login does not enforce a challenge yet
  // (auth.service loginWithEmailPassword): default off and labelled as such.
  const [inviteMfa, setInviteMfa] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ email: string; invitation: InvitationResult | undefined } | null>(null);

  // Re-issue result shown in the detail drawer.
  const [reissueResult, setReissueResult] = useState<{ userId: string; invitation: InvitationResult } | null>(null);

  // Role change state (per-selected-user).
  const [roleDraft, setRoleDraft] = useState("");

  // Destructive action: the button opens a CocoaDialog; only its confirm calls the API.
  const [confirmDisable, setConfirmDisable] = useState(false);

  const selected = selectedId ? (users.find((u) => u.id === selectedId) ?? null) : null;
  const selectedAssignment = (selected?.departments ?? []).find((d) => d.active) ?? null;
  const selectedPending = selected?.status === "invited" ? describePendingInvitation(selected.pendingInvitation) : null;
  const selectedBadge = selected ? statusBadge(selected) : null;

  useEffect(() => {
    if (!inviteOpen) return;
    let cancelled = false;
    setRolesError(null);
    fetchPropertyRoles(PROPERTY_ID)
      .then((list) => {
        if (cancelled) return;
        setRoles(list);
        setInviteRoleId((current) => (current && list.some((r) => r.id === current) ? current : (list[0]?.id ?? "")));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setRoles([]);
        setRolesError(e instanceof Error ? e.message : "No se pudieron cargar los roles.");
      });
    fetchEmailStatus()
      .then((status) => {
        if (!cancelled) setEmailStatus(status);
      })
      .catch(() => {
        // Informative hint only: the invite response carries the real delivery.
        if (!cancelled) setEmailStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [inviteOpen]);

  function openDetail(user: BackOfficeUser) {
    setSelectedId(user.id);
    setReissueResult(null);
    const assignment = (user.departments ?? []).find((d) => d.active);
    setRoleDraft(assignment?.roleLabel ?? "");
  }

  function closeDetail() {
    setSelectedId(null);
    setReissueResult(null);
    setRoleDraft("");
  }

  function resetInviteForm() {
    setInviteName("");
    setInviteEmail("");
    setInvitePhone("");
    setInviteMfa(false);
    setInviteResult(null);
  }

  function closeInvite() {
    setInviteOpen(false);
    setInviteResult(null);
  }

  const canInvite = Boolean(inviteName.trim() && inviteEmail.trim() && inviteRoleId) && !busy;

  async function handleInvite() {
    if (!inviteName.trim() || !inviteEmail.trim()) {
      showToast("Nombre y email son obligatorios", { variant: "error" });
      return;
    }
    if (!inviteRoleId) {
      showToast("Selecciona un rol para el usuario", { variant: "error" });
      return;
    }
    const email = inviteEmail.trim();
    setBusy(true);
    try {
      const response = await inviteBackOfficeUser(PROPERTY_ID, {
        email,
        fullName: inviteName.trim(),
        phone: invitePhone.trim() || undefined,
        roleId: inviteRoleId,
        mfaRequired: inviteMfa
      });
      const invitation = response?.invitation;
      if (invitation?.delivery?.status === "sent") {
        showToast(`Invitación enviada a ${email}`, { variant: "success" });
      } else {
        showToast(`Usuario creado. ${describeDelivery(invitation?.delivery).title}.`, { variant: "info", duration: 6000 });
      }
      setInviteResult({ email, invitation });
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo crear la invitación.";
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  /**
   * POST …/users/:id/reissue-invite for the selected user (drawer) or for a
   * row's «Reenviar» action. The outcome — real delivery, or the copyable
   * single-use link when no email went out — is shown in the detail drawer,
   * which opens for the row case so nothing is claimed silently.
   */
  async function handleReissue(target: BackOfficeUser | null = selected) {
    if (!target) return;
    setBusy(true);
    try {
      const invitation = await reissueBackOfficeInvitation(PROPERTY_ID, target.id);
      if (invitation.delivery?.status === "sent") {
        showToast(`Invitación reenviada a ${target.email}`, { variant: "success" });
      } else {
        showToast(describeDelivery(invitation.delivery).title, { variant: "info", duration: 6000 });
      }
      if (selectedId !== target.id) {
        setSelectedId(target.id);
        setRoleDraft((target.departments ?? []).find((d) => d.active)?.roleLabel ?? "");
      }
      setReissueResult({ userId: target.id, invitation });
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo reenviar la invitación.";
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    if (!selected) return;
    setBusy(true);
    try {
      await apiRequest(`/backoffice/properties/${PROPERTY_ID}/users/${selected.id}/disable`, {
        method: "POST"
      });
      showToast(`Usuario ${selected.fullName} desactivado`, { variant: "success" });
      setConfirmDisable(false);
      refresh();
      closeDetail();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo desactivar el usuario.";
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleChangeRole() {
    if (!selected || !selectedAssignment) return;
    const trimmed = roleDraft.trim();
    if (!trimmed) {
      showToast("Indica un rol", { variant: "error" });
      return;
    }
    if (trimmed === (selectedAssignment.roleLabel ?? "")) {
      showToast("El rol no ha cambiado", { variant: "info" });
      return;
    }
    setBusy(true);
    try {
      // Reuse the department assignment endpoint to update the roleLabel of the
      // user's existing active department. The service treats POST as upsert
      // semantically (same userId+departmentId), so we just resubmit with the
      // new label.
      await apiRequest(`/backoffice/properties/${PROPERTY_ID}/departments/${selectedAssignment.departmentId}/users`, {
        method: "POST",
        body: {
          userId: selected.id,
          roleLabel: trimmed
        }
      });
      showToast(`Rol actualizado a «${trimmed}»`, { variant: "success" });
      refresh();
      closeDetail();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo cambiar el rol.";
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const emailHint =
    emailStatus && emailStatus.mode !== "real"
      ? emailStatus.mode === "simulated"
        ? "El email saliente de este servidor no envía correos reales. Al crear la invitación te mostraremos el enlace para que lo entregues tú."
        : "No hay proveedor de email configurado (EMAIL_PROVIDER / EMAIL_FROM). Al crear la invitación te mostraremos el enlace para que lo entregues tú."
      : null;

  const inviteLabel = "Invitar usuario";
  const ready = !loading && !error && users.length > 0;

  // Columns are typed with the row; the busy flag and the reissue handler come from the closure.
  const columns: CocoaTableColumn<BackOfficeUser>[] = [
    {
      key: "fullName",
      label: "Nombre",
      render: (user) => (
        <span className="cocoa-cluster">
          <strong>{user.fullName}</strong>
          {user.mfaEnabled ? (
            <CocoaBadge tone="neutral" size="small">
              MFA
            </CocoaBadge>
          ) : null}
        </span>
      )
    },
    { key: "email", label: "Correo" },
    { key: "role", label: "Rol", render: (user) => primaryRole(user) },
    { key: "lastLoginAt", label: "Último acceso", fit: true, hideOnNarrow: true, render: (user) => fmtDateTime(user.lastLoginAt) },
    {
      key: "status",
      label: "Estado",
      fit: true,
      render: (user) => {
        const badge = statusBadge(user);
        return (
          <CocoaBadge tone={badge.tone} uppercase={false} title={badge.detail}>
            {badge.label}
          </CocoaBadge>
        );
      }
    }
  ];

  let body;
  if (loading && !data) {
    body = <CocoaTable columns={columns} rows={[]} loading aria-label="Usuarios" />;
  } else if (error) {
    body = <CocoaState kind="error" title={STATUS_LABELS.loadError} message={error} onRetry={() => refresh()} />;
  } else if (users.length === 0) {
    body = <CocoaState kind="empty" title="Sin usuarios" message="Invita al primer usuario para comenzar a operar la propiedad." primaryAction={{ label: inviteLabel, onClick: () => setInviteOpen(true) }} />;
  } else {
    body = (
      <CocoaTable
        columns={columns}
        rows={users}
        rowKey="id"
        selectedKey={selected?.id}
        onSelect={openDetail}
        rowActions={(user) => (
          <>
            {user.status === "invited" ? (
              <CocoaButton
                variant="plain"
                size="small"
                disabled={busy}
                title="Genera un enlace nuevo de un solo uso y anula el anterior"
                onClick={(event) => {
                  event.stopPropagation();
                  void handleReissue(user);
                }}
              >
                {ACTIONS.resend}
              </CocoaButton>
            ) : null}
            <CocoaButton
              variant="plain"
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                openDetail(user);
              }}
            >
              {ACTIONS.view}
            </CocoaButton>
          </>
        )}
        caption="Usuarios de la propiedad"
        aria-label="Usuarios de la propiedad"
      />
    );
  }

  return (
    <CocoaPage
      eyebrow="Configuración · Usuarios"
      title="Usuarios y roles"
      subtitle={hosted ? undefined : "Invita usuarios con un rol, reenvía invitaciones pendientes y desactiva accesos. Todos los cambios quedan en el registro de auditoría."}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => refresh()} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setInviteOpen(true)} disabled={busy}>
            {inviteLabel}
          </CocoaButton>
        </>
      }
      commands={[
        { id: "users-invite", label: inviteLabel, run: () => setInviteOpen(true) },
        { id: "users-refresh", label: `${ACTIONS.refresh} usuarios`, run: () => refresh() }
      ]}
    >
      <CocoaSection padding={ready ? "none" : "md"} style={{ overflow: "clip" }} aria-label="Usuarios de la propiedad" footer={ready ? <span>{plural(users.length, "usuario", "usuarios")}</span> : undefined}>
        {body}
      </CocoaSection>

      <CocoaDrawer
        open={inviteOpen}
        onClose={closeInvite}
        title={inviteResult ? "Invitación creada" : inviteLabel}
        subtitle={inviteResult ? inviteResult.email : "El usuario recibirá un enlace de un solo uso para crear su contraseña."}
        side="right"
        size="md"
        dismissible={!busy}
        focusKey={inviteResult !== null}
        footer={
          inviteResult ? (
            <>
              <CocoaButton variant="bordered" tone="neutral" onClick={resetInviteForm} disabled={busy}>
                Invitar a otra persona
              </CocoaButton>
              <CocoaButton variant="filled" tone="accent" onClick={closeInvite} disabled={busy}>
                {ACTIONS.close}
              </CocoaButton>
            </>
          ) : (
            <>
              <CocoaButton variant="bordered" tone="neutral" onClick={closeInvite} disabled={busy}>
                {ACTIONS.cancel}
              </CocoaButton>
              <CocoaButton variant="filled" tone="accent" onClick={() => void handleInvite()} disabled={!canInvite} loading={busy}>
                {busy ? "Creando…" : "Crear invitación"}
              </CocoaButton>
            </>
          )
        }
      >
        {inviteResult ? (
          <InvitationOutcome email={inviteResult.email} invitation={inviteResult.invitation} />
        ) : (
          <div className="cocoa-stack" data-gap="4">
            <CocoaFormSection title="Persona" columns={1}>
              <CocoaField label="Nombre completo" required>
                <CocoaInput value={inviteName} onChange={setInviteName} disabled={busy} placeholder="Marta Pérez" autoComplete="off" />
              </CocoaField>
              <CocoaField label="Correo electrónico" required>
                <CocoaInput value={inviteEmail} onChange={setInviteEmail} type="email" inputMode="email" disabled={busy} placeholder="marta@hotel.com" autoComplete="off" />
              </CocoaField>
              <CocoaField label="Teléfono" hint={STATUS_LABELS.optional.toLowerCase()}>
                <CocoaInput value={invitePhone} onChange={setInvitePhone} type="tel" inputMode="tel" disabled={busy} placeholder="+34 …" autoComplete="off" />
              </CocoaField>
            </CocoaFormSection>

            <CocoaFormSection title="Acceso" columns={1}>
              <CocoaField
                label="Rol"
                required
                error={rolesError ?? undefined}
                help={roles !== null && roles.length === 0 && !rolesError ? "La organización no tiene roles definidos: sin rol el usuario no tendría permisos. Crea uno antes de invitar." : undefined}
              >
                <CocoaSelect
                  value={inviteRoleId}
                  onChange={setInviteRoleId}
                  disabled={busy || roles === null || roles.length === 0}
                  placeholder={roles === null ? "Cargando roles…" : roles.length === 0 ? "Sin roles definidos" : undefined}
                  options={(roles ?? []).map((role) => ({ value: role.id, label: role.name }))}
                />
              </CocoaField>
              <CocoaField label="Marcar MFA como requerido" inline help="El inicio de sesión aún no aplica el reto MFA: solo queda anotado en el usuario.">
                <CocoaSwitch checked={inviteMfa} onChange={setInviteMfa} disabled={busy} size="small" />
              </CocoaField>
            </CocoaFormSection>

            {emailHint ? (
              <CocoaCallout tone="warning" title="El email saliente no está configurado">
                {emailHint}
              </CocoaCallout>
            ) : null}
            <p className="cocoa-note">
              El usuario quedará en estado «Invitado» hasta que acepte el enlace y cree su contraseña. La fecha de caducidad la fija la API y se muestra al crear la invitación.
            </p>
          </div>
        )}
      </CocoaDrawer>

      <CocoaDrawer
        open={selected !== null}
        onClose={closeDetail}
        title={selected?.fullName ?? "Usuario"}
        subtitle={selected?.email}
        side="right"
        size="md"
        dismissible={!busy}
        footer={
          selected ? (
            <>
              <CocoaButton variant="bordered" tone="neutral" onClick={closeDetail} disabled={busy}>
                {ACTIONS.close}
              </CocoaButton>
              {selected.status !== "disabled" ? (
                <CocoaButton variant="bordered" tone="destructive" disabled={busy} onClick={() => setConfirmDisable(true)}>
                  {ACTIONS.deactivate}
                </CocoaButton>
              ) : null}
            </>
          ) : undefined
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="4">
            <ul className="c22-section__list" aria-label="Datos del usuario">
              <li>
                <span>Estado</span>
                <CocoaBadge tone={selectedBadge?.tone ?? "info"} uppercase={false}>
                  {selectedBadge?.label ?? selected.status}
                </CocoaBadge>
              </li>
              <li>
                <span>MFA</span>
                <strong>{selected.mfaEnabled ? "Marcado como requerido" : "No requerido"}</strong>
              </li>
              {selected.phone ? (
                <li>
                  <span>Teléfono</span>
                  <strong>{selected.phone}</strong>
                </li>
              ) : null}
              <li>
                <span>Último acceso</span>
                <strong>{fmtDateTime(selected.lastLoginAt)}</strong>
              </li>
              <li>
                <span>Identificador</span>
                <code className="cocoa-mono">{selected.id}</code>
              </li>
            </ul>

            {selected.status === "invited" ? (
              <CocoaSection
                title="Invitación"
                action={
                  <CocoaButton variant="plain" size="small" disabled={busy} onClick={() => void handleReissue()}>
                    {selectedPending?.tone === "error" ? "Reenviar invitación (caducada)" : "Reenviar invitación"}
                  </CocoaButton>
                }
              >
                {reissueResult && reissueResult.userId === selected.id ? (
                  <InvitationOutcome email={selected.email} invitation={reissueResult.invitation} />
                ) : selectedPending ? (
                  <div className="cocoa-stack" data-gap="2">
                    <CocoaBadge tone={TONE[selectedPending.tone]} uppercase={false} style={{ alignSelf: "flex-start" }}>
                      {selectedPending.label}
                    </CocoaBadge>
                    <p className="cocoa-note">{selectedPending.detail}</p>
                  </div>
                ) : (
                  <p className="cocoa-note">
                    Pendiente de aceptar; la API no informa de la caducidad de esta invitación. «Reenviar invitación» genera un enlace nuevo de un solo uso y anula los anteriores.
                  </p>
                )}
              </CocoaSection>
            ) : null}

            <CocoaSection title="Departamentos" meta={plural((selected.departments ?? []).length, "asignación", "asignaciones")}>
              {(selected.departments ?? []).length === 0 ? (
                <CocoaState kind="empty" inline title="Sin asignaciones de departamento." />
              ) : (
                <ul className="c22-section__list" aria-label="Departamentos del usuario">
                  {(selected.departments ?? []).map((assignment) => (
                    <li key={assignment.id}>
                      <span>
                        <strong>{assignment.department?.name ?? assignment.departmentId}</strong>
                        {assignment.roleLabel ? <span className="cocoa-note"> · {assignment.roleLabel}</span> : null}
                      </span>
                      <CocoaBadge tone={assignment.active ? "success" : "neutral"} size="small">
                        {assignment.active ? STATUS_LABELS.active : STATUS_LABELS.inactive}
                      </CocoaBadge>
                    </li>
                  ))}
                </ul>
              )}
            </CocoaSection>

            {selectedAssignment && selected.status !== "disabled" ? (
              <CocoaFormSection
                title="Cambiar rol"
                description={`Rol en ${selectedAssignment.department?.name ?? "el departamento"}. Se guarda en la asignación del departamento.`}
                columns={1}
                actions={
                  <CocoaButton variant="filled" tone="accent" size="small" disabled={busy || !roleDraft.trim() || roleDraft.trim() === (selectedAssignment.roleLabel ?? "")} onClick={() => void handleChangeRole()}>
                    Guardar rol
                  </CocoaButton>
                }
              >
                <CocoaField label="Rol">
                  <CocoaInput value={roleDraft} onChange={setRoleDraft} placeholder="Jefe de recepción" disabled={busy} autoComplete="off" />
                </CocoaField>
              </CocoaFormSection>
            ) : null}
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDialog
        open={confirmDisable && selected !== null}
        onClose={() => setConfirmDisable(false)}
        tone="destructive"
        title={`¿Desactivar a ${selected?.fullName ?? "este usuario"}?`}
        description="Perderá el acceso a esta propiedad de inmediato. Podrás volver a invitarle más adelante; la acción queda en el registro de auditoría."
        confirmLabel={ACTIONS.deactivate}
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        onConfirm={handleDisable}
      />
    </CocoaPage>
  );
}
