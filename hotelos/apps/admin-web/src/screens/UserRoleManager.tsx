// User Role Manager — invite and govern Back Office users for the active
// property. Reads GET /backoffice/properties/:propertyId/users and exposes:
//
//   • a top-right "Invitar usuario" drawer: name, email, phone and the ROLE
//     (GET /backoffice/properties/:propertyId/roles — the organization's
//     Prisma roles). POST /users/invite persists the user + a single-use
//     invitation and reports how the email really went out. Only a real
//     `delivery.status === "sent"` is announced as "Invitación enviada"; when
//     the server email is simulated / disabled / failed we show the copyable
//     invite link instead (Tanda 3 · CFG-P1-6 — no more fake toasts).
//   • a row drawer with detail, "Reenviar invitación" (POST
//     /users/:userId/reissue-invite, revokes the previous tokens) for invited
//     users and a "Desactivar" action (POST /users/:userId/disable).
//   • a "Cambiar rol" affordance scoped to the user's primary department
//     assignment when one exists (department `roleLabel`, displayed as-is).
//
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
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../components/States";
import { SidePanel, DetailRow } from "../components/SidePanel";
import { useToast } from "../components/Toast";
import { toArray } from "../utils/toArray";

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

const STATUS_LABEL: Record<BackOfficeUser["status"], string> = {
  active: "Activo",
  invited: "Invitado · pendiente",
  disabled: "Desactivado"
};
const STATUS_KIND: Record<BackOfficeUser["status"], "ok" | "warn" | "error"> = {
  active: "ok",
  invited: "warn",
  disabled: "error"
};

/**
 * Status tag of a row. Invited users read their real invitation state from
 * `pendingInvitation` (expiry / expired); when the API does not expose it the
 * bare status is shown instead of guessing.
 */
function statusBadge(user: BackOfficeUser): { tone: "ok" | "warn" | "error" | "info"; label: string; detail?: string } {
  if (user.status === "invited") {
    const pending = describePendingInvitation(user.pendingInvitation);
    if (pending) return { tone: pending.tone, label: pending.tone === "error" ? "Invitación caducada" : pending.label, detail: pending.detail };
  }
  return { tone: STATUS_KIND[user.status] ?? "info", label: STATUS_LABEL[user.status] ?? user.status };
}

function fmtDateTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function primaryRole(user: BackOfficeUser): string {
  const assignment = (user.departments ?? []).find((d) => d.active);
  if (!assignment) return "—";
  if (assignment.roleLabel) return assignment.roleLabel;
  return assignment.department?.name ?? assignment.departmentId;
}

/** Read-only value with a copy button (bo-* styling, no Cocoa dependency). */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    if (await copyText(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }
  return (
    <label className="bo-form-field" style={{ margin: 0 }}>
      <span>{label}</span>
      <div style={{ display: "flex", gap: 8 }}>
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, minWidth: 0, fontSize: 12 }} />
        <button type="button" onClick={() => void handleCopy()}>{copied ? "Copiado" : "Copiar"}</button>
      </div>
    </label>
  );
}

/**
 * Honest outcome of an invitation: green only for a real send; otherwise the
 * link to hand over by another channel, plus the expiry.
 */
function InvitationOutcome({ email, invitation }: { email: string; invitation: InvitationResult | undefined }) {
  const delivery = describeDelivery(invitation?.delivery, email);
  const showLink = Boolean(invitation?.inviteUrl) && invitation?.delivery?.status !== "sent";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className={`bo-status ${delivery.tone}`} style={{ textTransform: "none", padding: "8px 10px", display: "block", lineHeight: 1.4 }}>
        <strong>{delivery.title}</strong>
        <div style={{ fontWeight: 400, marginTop: 2 }}>{delivery.detail}</div>
      </div>
      {showLink && invitation ? <CopyField label="Enlace de invitación (un solo uso)" value={invitation.inviteUrl} /> : null}
      <p className="bo-muted" style={{ fontSize: 12, textTransform: "none", margin: 0 }}>
        Caduca el {formatExpiry(invitation?.expiresAt)}. Reenviar la invitación genera un enlace nuevo y anula este.
      </p>
    </div>
  );
}

export function UserRoleManager() {
  const { showToast } = useToast();
  const { data, loading, error, refresh } = useApiData<BackOfficeUser[]>(
    `/backoffice/properties/${PROPERTY_ID}/users`
  );

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

  const selected = selectedId ? users.find((u) => u.id === selectedId) ?? null : null;
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
        setInviteRoleId((current) => (current && list.some((r) => r.id === current) ? current : list[0]?.id ?? ""));
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
   * POST …/users/:id/reissue-invite for the selected user (drawer footer) or
   * for a row's "Reenviar" button. The outcome — real delivery, or the
   * copyable single-use link when no email went out — is shown in the detail
   * drawer, which opens for the row case so nothing is claimed silently.
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
      await apiRequest(
        `/backoffice/properties/${PROPERTY_ID}/departments/${selectedAssignment.departmentId}/users`,
        {
          method: "POST",
          body: {
            userId: selected.id,
            roleLabel: trimmed
          }
        }
      );
      showToast(`Rol actualizado a "${trimmed}"`, { variant: "success" });
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
        ? "El email saliente está en modo simulado en este servidor: no se enviará ningún email. Al crear la invitación te mostraremos el enlace para que lo entregues tú."
        : "No hay proveedor de email configurado (EMAIL_PROVIDER / EMAIL_FROM). Al crear la invitación te mostraremos el enlace para que lo entregues tú."
      : null;

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Control de acceso</p>
          <h2 style={{ color: "var(--ink)" }}>Gestión de usuarios y roles</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Invita usuarios con un rol, reenvía invitaciones pendientes y desactiva accesos. Todos los cambios quedan registrados en el log de auditoría.
          </p>
        </div>
        <div className="bo-pill-row">
          {busy ? <Spinner size="sm" /> : null}
          <button type="button" onClick={() => refresh()} disabled={loading}>↻ Actualizar</button>
          <button type="button" className="primary" onClick={() => setInviteOpen(true)} disabled={busy}>+ Invitar usuario</button>
        </div>
      </header>

      {loading && !data ? (
        <LoadingBlock label="Cargando usuarios…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={() => refresh()} />
      ) : users.length === 0 ? (
        <EmptyState
          title="Sin usuarios"
          message="Invita al primer usuario para comenzar a operar la propiedad."
          actions={<button type="button" className="primary" onClick={() => setInviteOpen(true)}>+ Invitar usuario</button>}
        />
      ) : (
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Usuarios</h3>
            <span className="bo-chip">{users.length}</span>
          </div>
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Último login</th><th>Estado</th></tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const badge = statusBadge(user);
                  return (
                    <tr key={user.id} style={{ cursor: "pointer" }} onClick={() => openDetail(user)}>
                      <td>
                        <strong>{user.fullName}</strong>
                        {user.mfaEnabled ? <span className="bo-chip" style={{ marginLeft: 6, fontSize: 10 }}>MFA</span> : null}
                      </td>
                      <td>{user.email}</td>
                      <td>{primaryRole(user)}</td>
                      <td>{fmtDateTime(user.lastLoginAt)}</td>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span className={`bo-status ${badge.tone}`} style={{ textTransform: "none" }} title={badge.detail}>
                            {badge.label}
                          </span>
                          {user.status === "invited" ? (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleReissue(user);
                              }}
                              title="Genera un enlace nuevo de un solo uso y anula el anterior"
                            >
                              Reenviar
                            </button>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </article>
      )}

      <SidePanel
        open={inviteOpen}
        title={inviteResult ? "Invitación creada" : "Invitar usuario"}
        subtitle={inviteResult ? inviteResult.email : "El usuario recibirá un enlace de un solo uso para crear su contraseña."}
        onClose={closeInvite}
        footer={
          inviteResult ? (
            <>
              <button type="button" onClick={resetInviteForm} disabled={busy}>Invitar a otra persona</button>
              <button type="button" className="primary" onClick={closeInvite} disabled={busy}>Cerrar</button>
            </>
          ) : (
            <>
              <button type="button" onClick={closeInvite} disabled={busy}>Cancelar</button>
              <button type="button" className="primary" onClick={() => void handleInvite()} disabled={!canInvite}>
                {busy ? <><Spinner size="sm" /> Creando…</> : "Crear invitación"}
              </button>
            </>
          )
        }
      >
        {inviteResult ? (
          <InvitationOutcome email={inviteResult.email} invitation={inviteResult.invitation} />
        ) : (
          <>
            <label className="bo-form-field">
              <span>Nombre completo *</span>
              <input value={inviteName} onChange={(e) => setInviteName(e.target.value)} disabled={busy} placeholder="Ej.: Marta Pérez" />
            </label>
            <label className="bo-form-field">
              <span>Email *</span>
              <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} disabled={busy} placeholder="marta@hotel.com" />
            </label>
            <label className="bo-form-field">
              <span>Teléfono</span>
              <input value={invitePhone} onChange={(e) => setInvitePhone(e.target.value)} disabled={busy} placeholder="+34 …" />
            </label>
            <label className="bo-form-field">
              <span>Rol *</span>
              <select value={inviteRoleId} onChange={(e) => setInviteRoleId(e.target.value)} disabled={busy || roles === null || roles.length === 0}>
                {roles === null ? <option value="">Cargando roles…</option> : null}
                {roles !== null && roles.length === 0 ? <option value="">Sin roles definidos</option> : null}
                {(roles ?? []).map((role) => (
                  <option key={role.id} value={role.id}>{role.name}</option>
                ))}
              </select>
            </label>
            {rolesError ? (
              <p className="bo-status error" style={{ textTransform: "none", display: "block", padding: "6px 10px" }}>{rolesError}</p>
            ) : roles !== null && roles.length === 0 ? (
              <p className="bo-muted" style={{ fontSize: 12, textTransform: "none", marginTop: 4 }}>
                La organización no tiene roles definidos: sin rol el usuario no tendría permisos. Crea uno antes de invitar.
              </p>
            ) : null}
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, fontSize: 13 }}>
              <input type="checkbox" checked={inviteMfa} onChange={(e) => setInviteMfa(e.target.checked)} disabled={busy} />
              <span>Marcar MFA como requerido (el inicio de sesión aún no aplica el reto MFA)</span>
            </label>
            {emailHint ? (
              <p className="bo-status warn" style={{ textTransform: "none", display: "block", padding: "8px 10px", lineHeight: 1.4, marginTop: 8 }}>
                {emailHint}
              </p>
            ) : null}
            <p className="bo-muted" style={{ fontSize: 12, textTransform: "none", marginTop: 8 }}>
              El usuario quedará en estado «Invitado» hasta que acepte el enlace y cree su contraseña. La fecha de caducidad la fija la API y se muestra al crear la invitación.
            </p>
          </>
        )}
      </SidePanel>

      <SidePanel
        open={!!selected}
        title={selected?.fullName ?? ""}
        subtitle={selected?.email}
        onClose={closeDetail}
        footer={
          selected ? (
            <>
              <button type="button" onClick={closeDetail} disabled={busy}>Cerrar</button>
              {selected.status === "invited" ? (
                <button type="button" disabled={busy} onClick={() => void handleReissue()}>
                  {selectedPending?.tone === "error" ? "Reenviar invitación (caducada)" : "Reenviar invitación"}
                </button>
              ) : null}
              {selected.status !== "disabled" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleDisable()}
                  style={{ borderColor: "var(--danger-ink, #c2413a)", color: "var(--danger-ink, #c2413a)" }}
                >
                  Desactivar
                </button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {selected ? (
          <>
            <DetailRow label="Estado">
              <span className={`bo-status ${selectedBadge?.tone ?? "info"}`} style={{ textTransform: "none" }}>
                {selectedBadge?.label ?? selected.status}
              </span>
            </DetailRow>
            <DetailRow label="MFA">{selected.mfaEnabled ? "Marcado como requerido" : "No requerido"}</DetailRow>
            {selected.phone ? <DetailRow label="Teléfono">{selected.phone}</DetailRow> : null}
            <DetailRow label="Último login">{fmtDateTime(selected.lastLoginAt)}</DetailRow>
            <DetailRow label="ID"><code style={{ fontSize: 11 }}>{selected.id}</code></DetailRow>

            {selected.status === "invited" ? (
              <div style={{ marginTop: 12, padding: 12, background: "var(--surface-soft)", borderRadius: "var(--radius-md, 8px)", border: "1px solid var(--line-soft)" }}>
                <p className="bo-muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Invitación</p>
                {reissueResult && reissueResult.userId === selected.id ? (
                  <InvitationOutcome email={selected.email} invitation={reissueResult.invitation} />
                ) : selectedPending ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span className={`bo-status ${selectedPending.tone}`} style={{ textTransform: "none", alignSelf: "flex-start" }}>
                      {selectedPending.label}
                    </span>
                    <p className="bo-muted" style={{ fontSize: 13, textTransform: "none", margin: 0 }}>{selectedPending.detail}</p>
                  </div>
                ) : (
                  <p className="bo-muted" style={{ fontSize: 13, textTransform: "none", margin: 0 }}>
                    Pendiente de aceptar; la API no informa de la caducidad de esta invitación. «Reenviar invitación» genera un enlace nuevo de un solo uso y anula los anteriores.
                  </p>
                )}
              </div>
            ) : null}

            <div style={{ marginTop: 12 }}>
              <p className="bo-muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Departamentos</p>
              {(selected.departments ?? []).length === 0 ? (
                <p className="bo-muted" style={{ fontSize: 13, textTransform: "none" }}>Sin asignaciones de departamento.</p>
              ) : (
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                  {(selected.departments ?? []).map((assignment) => (
                    <li key={assignment.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, padding: "4px 0", borderBottom: "1px solid var(--line-soft)" }}>
                      <span>
                        <strong>{assignment.department?.name ?? assignment.departmentId}</strong>
                        {assignment.roleLabel ? <span className="bo-muted"> · {assignment.roleLabel}</span> : null}
                      </span>
                      <span className={`bo-status ${assignment.active ? "ok" : "info"}`} style={{ textTransform: "none", fontSize: 11 }}>
                        {assignment.active ? "activo" : "inactivo"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {selectedAssignment && selected.status !== "disabled" ? (
              <div style={{ marginTop: 12, padding: 12, background: "var(--surface-soft)", borderRadius: "var(--radius-md, 8px)", border: "1px solid var(--line-soft)" }}>
                <p className="bo-muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Cambiar rol</p>
                <label className="bo-form-field" style={{ margin: 0 }}>
                  <span>Rol en {selectedAssignment.department?.name ?? "el departamento"}</span>
                  <input
                    value={roleDraft}
                    onChange={(e) => setRoleDraft(e.target.value)}
                    placeholder="Ej.: Reception Manager"
                    disabled={busy}
                  />
                </label>
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !roleDraft.trim() || roleDraft.trim() === (selectedAssignment.roleLabel ?? "")}
                    onClick={() => void handleChangeRole()}
                  >
                    Guardar rol
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </SidePanel>
    </section>
  );
}
