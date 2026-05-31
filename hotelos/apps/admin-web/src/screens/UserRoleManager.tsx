// User Role Manager — invite and govern Back Office users for the active
// property. Reads GET /backoffice/properties/:propertyId/users and exposes:
//
//   • a top-right "Invitar usuario" drawer that POSTs /users/invite
//   • a row drawer with detail and a "Desactivar" action that POSTs
//     /users/:userId/disable (idempotent on the server)
//   • a "Cambiar rol" affordance scoped to the user's primary department
//     assignment when one exists (the backend models role as department
//     `roleLabel` rather than a global property; we display it as-is).
//
// Permissions: users.invite and users.disable. Failures surface via toast.

import { useMemo, useState } from "react";
import { getActivePropertyId } from "../services/activeProperty";
import { useApiData } from "../hooks/useApiData";
import { apiRequest } from "../services/api-client";
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

type BackOfficeUser = {
  id: string;
  organizationId: string;
  email: string;
  phone?: string;
  fullName: string;
  status: "active" | "invited" | "disabled";
  mfaEnabled: boolean;
  lastLoginAt?: string;
  departments: DepartmentAssignment[];
};

const STATUS_LABEL: Record<BackOfficeUser["status"], string> = {
  active: "Activo",
  invited: "Invitado",
  disabled: "Desactivado"
};
const STATUS_KIND: Record<BackOfficeUser["status"], "ok" | "warn" | "error"> = {
  active: "ok",
  invited: "warn",
  disabled: "error"
};

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
  const assignment = user.departments.find((d) => d.active);
  if (!assignment) return "—";
  if (assignment.roleLabel) return assignment.roleLabel;
  return assignment.department?.name ?? assignment.departmentId;
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

  // Invite form state.
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePhone, setInvitePhone] = useState("");
  const [inviteMfa, setInviteMfa] = useState(true);

  // Role change state (per-selected-user).
  const [roleDraft, setRoleDraft] = useState("");

  const selected = selectedId ? users.find((u) => u.id === selectedId) ?? null : null;
  const selectedAssignment = selected?.departments.find((d) => d.active) ?? null;

  function openDetail(user: BackOfficeUser) {
    setSelectedId(user.id);
    const assignment = user.departments.find((d) => d.active);
    setRoleDraft(assignment?.roleLabel ?? "");
  }

  function closeDetail() {
    setSelectedId(null);
    setRoleDraft("");
  }

  async function handleInvite() {
    if (!inviteName.trim() || !inviteEmail.trim()) {
      showToast("Nombre y email son obligatorios", { variant: "error" });
      return;
    }
    setBusy(true);
    try {
      await apiRequest(`/backoffice/properties/${PROPERTY_ID}/users/invite`, {
        method: "POST",
        body: {
          email: inviteEmail.trim(),
          fullName: inviteName.trim(),
          phone: invitePhone.trim() || undefined,
          mfaRequired: inviteMfa
        }
      });
      showToast(`Invitación enviada a ${inviteEmail.trim()}`, { variant: "success" });
      setInviteName("");
      setInviteEmail("");
      setInvitePhone("");
      setInviteMfa(true);
      setInviteOpen(false);
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo enviar la invitación.";
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

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Control de acceso</p>
          <h2 style={{ color: "var(--ink)" }}>Gestión de usuarios y roles</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Invita usuarios, asigna roles por departamento, exige MFA y desactiva accesos. Todos los cambios quedan registrados en el log de auditoría.
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
                {users.map((user) => (
                  <tr key={user.id} style={{ cursor: "pointer" }} onClick={() => openDetail(user)}>
                    <td>
                      <strong>{user.fullName}</strong>
                      {user.mfaEnabled ? <span className="bo-chip" style={{ marginLeft: 6, fontSize: 10 }}>MFA</span> : null}
                    </td>
                    <td>{user.email}</td>
                    <td>{primaryRole(user)}</td>
                    <td>{fmtDateTime(user.lastLoginAt)}</td>
                    <td>
                      <span className={`bo-status ${STATUS_KIND[user.status]}`} style={{ textTransform: "none" }}>
                        {STATUS_LABEL[user.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      )}

      <SidePanel
        open={inviteOpen}
        title="Invitar usuario"
        subtitle="Se enviará una invitación al email indicado."
        onClose={() => setInviteOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setInviteOpen(false)} disabled={busy}>Cancelar</button>
            <button type="button" className="primary" onClick={() => void handleInvite()} disabled={busy || !inviteName.trim() || !inviteEmail.trim()}>
              {busy ? <><Spinner size="sm" /> Enviando…</> : "Enviar invitación"}
            </button>
          </>
        }
      >
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
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, fontSize: 13 }}>
          <input type="checkbox" checked={inviteMfa} onChange={(e) => setInviteMfa(e.target.checked)} disabled={busy} />
          <span>Requerir MFA al activar la cuenta</span>
        </label>
        <p className="bo-muted" style={{ fontSize: 12, textTransform: "none", marginTop: 8 }}>
          El usuario quedará en estado «Invitado» hasta que complete el alta.
        </p>
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
              <span className={`bo-status ${STATUS_KIND[selected.status]}`} style={{ textTransform: "none" }}>
                {STATUS_LABEL[selected.status]}
              </span>
            </DetailRow>
            <DetailRow label="MFA">{selected.mfaEnabled ? "Requerido" : "No requerido"}</DetailRow>
            {selected.phone ? <DetailRow label="Teléfono">{selected.phone}</DetailRow> : null}
            <DetailRow label="Último login">{fmtDateTime(selected.lastLoginAt)}</DetailRow>
            <DetailRow label="ID"><code style={{ fontSize: 11 }}>{selected.id}</code></DetailRow>

            <div style={{ marginTop: 12 }}>
              <p className="bo-muted" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>Departamentos</p>
              {selected.departments.length === 0 ? (
                <p className="bo-muted" style={{ fontSize: 13, textTransform: "none" }}>Sin asignaciones de departamento.</p>
              ) : (
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
                  {selected.departments.map((assignment) => (
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
